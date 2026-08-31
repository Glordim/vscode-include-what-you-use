import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import { CompilationDatabase, CompileEntry } from './compilationDatabase';
import { pickFolderIntegrated } from './ui';
import { parseFixIncludesDryRun } from './diff';
import { ProposalController } from './proposals';

// --- Utils ---

/**
 * Returns the raw compiler command line for a compile_commands.json entry,
 * whether it was stored as a `command` string or an `arguments` array.
 */
function getEntryCommand(entry: CompileEntry): string {
	return entry.command ?? (entry.arguments ? entry.arguments.join(' ') : '');
}

function getEntryFilePath(entry: CompileEntry): string {
	return path.isAbsolute(entry.file) ? entry.file : path.resolve(entry.directory, entry.file);
}

/**
 * Normalizes a path for comparison against IWYU's reported filenames, which
 * use forward slashes regardless of platform. Case-insensitive, matching
 * Windows' (and this extension's other) filesystem assumptions.
 */
function normalizePathForCompare(p: string): string {
	return p.replace(/\\/g, '/').toLowerCase();
}

/**
 * Splits a command line string into arguments, respecting double quotes.
 */
function splitArguments(cmd: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuotes = false;

	for (let i = 0; i < cmd.length; i++) {
		const char = cmd[i];
		if (char === '"') {
			inQuotes = !inQuotes;
		} else if (char === ' ' && !inQuotes) {
			if (current.length > 0) {
				args.push(current.replace(/^"|"$/g, ''));
				current = "";
			}
		} else {
			current += char;
		}
	}
	if (current.length > 0) {
		args.push(current.replace(/^"|"$/g, ''));
	}
	return args;
}

/**
 * Retrieves the IWYU path from settings and cleans quotes.
 */
function getIwyuPath(): string {
	const config = vscode.workspace.getConfiguration('iwyu');
	const exe = config.get<string>('iwyu.path') || 'include-what-you-use';
	return exe.replace(/^"|"$/g, '');
}

function getFixIncludesPath(): string {
	const config = vscode.workspace.getConfiguration('iwyu');
	return config.get<string>('fixIncludes.path') || 'fix_includes.py';
}

/**
 * Prepares the argument array for the IWYU process.
 */
function prepareIwyuArgs(compileCmd: string, workspaceFolder: vscode.WorkspaceFolder): string[] {
	const config = vscode.workspace.getConfiguration('iwyu');
	const mappingFiles = config.get<string[]>('iwyu.mappingFiles') || [];
	const additionalArgs = config.get<string[]>('iwyu.additionalArgs') || [];

	const iwyuFlags: string[] = [];
	const clangFlags: string[] = [];
	let hasPch = false;

	const args = splitArguments(compileCmd);
	const compilerExe = args.shift() || "";

	// Set driver mode if using clang-cl
	if (compilerExe.toLowerCase().includes('clang-cl')) {
		clangFlags.push("--driver-mode=cl");
	}

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		// Skip compiler-only or irrelevant flags
		if (arg === '--' || arg === '-c') continue;

		// Strip PCH creation/usage
		if (arg.startsWith('/Yc') || arg.startsWith('/Yu') || arg.startsWith('/Fp') ||
			arg.startsWith('-Yc') || arg.startsWith('-Yu') || arg.startsWith('-Fp')) {
			hasPch = true;
			if ((arg === '/Fp' || arg === '/Yc' || arg === '/Yu' ||
				arg === '-Fp' || arg === '-Yc' || arg === '-Yu') && i + 1 < args.length) i++;
			continue;
		}

		// Strip Forced Includes / PCH includes
		if (arg.startsWith('/FI') || arg.startsWith('-include')) {
			hasPch = true;
			if ((arg === '/FI' || arg === '-include') && i + 1 < args.length) i++;
			continue;
		}

		if (arg === '-include-pch') {
			hasPch = true;
			i++;
			continue;
		}

		// Strip Output flags (/Fo, /o, -o)
		if (arg === '-o' || arg === '/o' || arg === '/Fo') {
			if (i + 1 < args.length) i++;
			continue;
		}
		if ((arg.startsWith('-o') || arg.startsWith('/o') || arg.startsWith('/Fo')) && arg.length > 2) {
			continue;
		}

		clangFlags.push(arg);
	}

	// Add Mappings
	mappingFiles.forEach(map => {
		const cleanedMap = map.replace(/"/g, '');
		const absMap = path.isAbsolute(cleanedMap) ? cleanedMap : path.join(workspaceFolder.uri.fsPath, cleanedMap);
		iwyuFlags.push("-Xiwyu", `--mapping_file=${absMap}`);
	});

	// Add Additional User Args
	additionalArgs.forEach(arg => {
		iwyuFlags.push("-Xiwyu", arg);
	});

	// Handle PCH
	if (hasPch) {
		iwyuFlags.push("-Xiwyu", "--pch_in_code");
	}

	return [...iwyuFlags, ...clangFlags];
}

// --- Per-entry operations ---

async function runIwyuDryRunOnEntry(
	entry: CompileEntry,
	workspaceFolder: vscode.WorkspaceFolder,
	outputChannel: vscode.OutputChannel,
	live: boolean
): Promise<{ code: number | null, report: string }> {
	const iwyuExe = getIwyuPath();
	const iwyuArgs = prepareIwyuArgs(getEntryCommand(entry), workspaceFolder);
	const filePath = getEntryFilePath(entry);

	let report = `[Running IWYU] ${filePath}\n[CWD] ${entry.directory}\n[Command] ${iwyuExe} ${iwyuArgs.join(' ')}\n`;
	if (live) {
		outputChannel.appendLine(`[Running IWYU] ${filePath}`);
		outputChannel.appendLine(`[CWD] ${entry.directory}`);
		outputChannel.appendLine(`[Command] ${iwyuExe} ${iwyuArgs.join(' ')}`);
	}

	return new Promise((resolve) => {
		const process = spawn(iwyuExe, iwyuArgs, {
			cwd: entry.directory,
			shell: false
		});

		process.stdout.on('data', (data) => {
			const chunk = data.toString();
			report += chunk;
			if (live) outputChannel.append(chunk);
		});
		process.stderr.on('data', (data) => {
			const chunk = data.toString();
			report += chunk;
			if (live) outputChannel.append(chunk);
		});

		process.on('error', (err) => {
			report += `\n[Error] ${err.message}`;
			if (live) outputChannel.appendLine(`[Error] ${err.message}`);
			resolve({ code: -1, report });
		});

		process.on('close', (code) => {
			report += `\n[Finished] Exit code: ${code}`;
			if (live) outputChannel.appendLine(`\n[Finished] Exit code: ${code}`);
			resolve({ code, report });
		});
	});
}

type FixStatus = 'success' | 'no-suggestions' | 'failed';

async function runIwyuFixOnEntry(
	entry: CompileEntry,
	workspaceFolder: vscode.WorkspaceFolder,
	outputChannel: vscode.OutputChannel,
	live: boolean,
	dryRun: boolean = false
): Promise<{ status: FixStatus, log: string, fixStdout: string }> {
	const iwyuExe = getIwyuPath();
	const iwyuArgs = prepareIwyuArgs(getEntryCommand(entry), workspaceFolder);
	const fixIncludesPy = getFixIncludesPath();
	const filePath = getEntryFilePath(entry);

	let log = `[Running IWYU] ${filePath}\n[CWD] ${entry.directory}\n[Command] ${iwyuExe} ${iwyuArgs.join(' ')}\n`;
	if (live) {
		outputChannel.appendLine(`[Running IWYU] ${filePath}`);
		outputChannel.appendLine(`[CWD] ${entry.directory}`);
		outputChannel.appendLine(`[Command] ${iwyuExe} ${iwyuArgs.join(' ')}`);
	}

	// 1. Run IWYU
	const iwyuReport = await new Promise<string>((resolve) => {
		const iwyuProcess = spawn(iwyuExe, iwyuArgs, { cwd: entry.directory });
		let out = '';

		iwyuProcess.stdout.on('data', (data) => {
			const chunk = data.toString();
			out += chunk;
			if (live) outputChannel.append(chunk);
		});
		iwyuProcess.stderr.on('data', (data) => {
			const chunk = data.toString();
			out += chunk;
			if (live) outputChannel.append(chunk);
		});

		iwyuProcess.on('close', () => resolve(out));
		iwyuProcess.on('error', (err) => {
			log += `\n[Error] Could not start IWYU: ${err.message}`;
			if (live) outputChannel.appendLine(`[Error] Could not start IWYU: ${err.message}`);
			resolve('');
		});
	});

	log += iwyuReport;
	if (live) outputChannel.appendLine(`\n--- IWYU Raw Report Finished ---`);

	if (iwyuReport.trim().length === 0) {
		log += `\n[Error] IWYU returned no suggestions to process.`;
		if (live) outputChannel.appendLine(`[Error] IWYU returned no suggestions to process.`);
		return { status: 'no-suggestions', log, fixStdout: '' };
	}

	const config = vscode.workspace.getConfiguration('iwyu');
	const additionalArgs = config.get<string[]>('fixIncludes.additionalArgs') || [];

	// 2. Prepare fix_includes.py
	const pythonArgs = [
		fixIncludesPy,
		...additionalArgs
	];
	if (dryRun) {
		pythonArgs.push('--dry_run');
	}

	if (live) {
		outputChannel.appendLine(`[Running Fix Script]`);
		outputChannel.appendLine(`[CWD] ${entry.directory}`);
		outputChannel.appendLine(`[Command] ${pythonArgs.join(' ')}`);
	}

	// Strip PYTHONHOME/PYTHONPATH: another extension (e.g. the Python
	// extension activating an interpreter) may have set these on the
	// extension host process. Left inherited, they can point Python's
	// stdlib lookup at a different install than the one that actually
	// gets launched, causing an SRE module MAGIC mismatch on import re.
	const fixEnv = { ...process.env };
	delete fixEnv.PYTHONHOME;
	delete fixEnv.PYTHONPATH;

	let fixStdout = '';

	const fixCode = await new Promise<number>((resolve) => {
		const fixProcess = spawn('python', pythonArgs, {
			cwd: entry.directory,
			shell: true,
			env: fixEnv
		});

		// Send the IWYU report to the Python script via STDIN
		fixProcess.stdin.write(iwyuReport);
		fixProcess.stdin.end();

		fixProcess.stdout.on('data', (data) => {
			const raw = data.toString();
			fixStdout += raw;
			const chunk = `[fix_includes.py] ${raw}`;
			log += chunk;
			if (live) outputChannel.append(chunk);
		});

		fixProcess.stderr.on('data', (data) => {
			const chunk = `[fix_includes.py ERR] ${data.toString()}`;
			log += chunk;
			if (live) outputChannel.append(chunk);
		});

		fixProcess.on('close', (code) => resolve(code ?? -1));
		fixProcess.on('error', (err) => {
			log += `\n[Error] Could not start fix_includes.py: ${err.message}`;
			if (live) outputChannel.appendLine(`[Error] Could not start fix_includes.py: ${err.message}`);
			resolve(-1);
		});
	});

	log += `\n[Finished] Fix script exited with code: ${fixCode}`;
	if (live) outputChannel.appendLine(`\n[Finished] Fix script exited with code: ${fixCode}`);

	// In --dry_run mode, fix_includes.py's exit code is not a success/failure
	// flag: it's min(files_with_changes, 100) (see fix_includes.py's main()).
	// A spawn error is still reported as -1 by the promise above.
	const status: FixStatus = dryRun
		? (fixCode === -1 ? 'failed' : 'success')
		: (fixCode === 0 ? 'success' : 'failed');

	return { status, log, fixStdout };
}

// --- Folder batch runner ---

async function runBatch(
	entries: CompileEntry[],
	title: string,
	task: (entry: CompileEntry) => Promise<void>
): Promise<boolean> {
	const total = entries.length;
	let completed = 0;
	let isCancelled = false;

	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title,
		cancellable: true
	}, async (progress, token) => {
		const limit = os.cpus().length;
		const queue = [...entries];

		token.onCancellationRequested(() => {
			isCancelled = true;
		});

		const runNext = async (): Promise<void> => {
			if (queue.length === 0 || isCancelled) return;

			const entry = queue.shift()!;
			const fileName = path.basename(entry.file);

			await task(entry);

			completed++;
			progress.report({
				increment: (1 / total) * 100,
				message: `${fileName} (${completed}/${total})`
			});

			return runNext();
		};

		const workers = Array(Math.min(limit, queue.length)).fill(null).map(() => runNext());
		await Promise.all(workers);
	});

	if (isCancelled) {
		vscode.window.showWarningMessage(`${title}: cancelled by user.`);
	}

	return !isCancelled;
}

/**
 * Resolves the active editor's compile database entry and workspace folder,
 * showing the appropriate error/warning message and returning undefined if
 * any step fails. Shared by the single-file commands.
 */
async function resolveActiveEntry(
	db: CompilationDatabase,
	outputChannel: vscode.OutputChannel,
	options?: { requireSaved?: boolean }
): Promise<{ editor: vscode.TextEditor, entry: CompileEntry, workspaceFolder: vscode.WorkspaceFolder } | undefined> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return undefined;

	if (options?.requireSaved && editor.document.isDirty) {
		vscode.window.showWarningMessage("IWYU: Please save the file before running this command — IWYU only analyzes the saved content.");
		return undefined;
	}

	const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
	if (!workspaceFolder) {
		vscode.window.showErrorMessage("File is not in a workspace folder.");
		return undefined;
	}

	const entry = await db.getEntryForFile(editor.document.uri);
	if (!entry) {
		outputChannel.appendLine(`IWYU: No entry found for ${editor.document.uri.fsPath}`);
		vscode.window.showWarningMessage(
			"IWYU: No compile command found for this file. Please ensure your project is configured (e.g., run CMake) and compile_commands.json is up to date."
		);
		return undefined;
	}

	return { editor, entry, workspaceFolder };
}

// --- Extension Activation ---

export function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel("Include What You Use");
	const db = new CompilationDatabase(outputChannel);
	const proposalController = new ProposalController();
	proposalController.register(context);

	context.subscriptions.push(outputChannel, db);

	const disposable = vscode.commands.registerCommand('include-what-you-use-iwyu.dry_run', async () => {
		const resolved = await resolveActiveEntry(db, outputChannel);
		if (!resolved) return;
		const { entry, workspaceFolder } = resolved;

		outputChannel.clear();
		outputChannel.show(true);

		const { report } = await runIwyuDryRunOnEntry(entry, workspaceFolder, outputChannel, true);

		const config = vscode.workspace.getConfiguration('iwyu');
		const openInNewFile = config.get<boolean>('dryRun.openInNewFile') || false;
		if (openInNewFile) {
			const doc = await vscode.workspace.openTextDocument({ content: report, language: 'plaintext' });
			await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
		}
	});

	context.subscriptions.push(disposable);

	const disposableFix = vscode.commands.registerCommand('include-what-you-use-iwyu.fix', async () => {
		const resolved = await resolveActiveEntry(db, outputChannel);
		if (!resolved) return;
		const { entry, workspaceFolder } = resolved;

		outputChannel.clear();
		outputChannel.show(true);

		const result = await runIwyuFixOnEntry(entry, workspaceFolder, outputChannel, true);

		if (result.status === 'success') {
			vscode.window.showInformationMessage("IWYU: Fix applied! Reverting file to load changes...");
			// Reload the file to show the changes immediately
			vscode.commands.executeCommand('workbench.action.files.revert');
		} else if (result.status === 'failed') {
			vscode.window.showErrorMessage(`fix_includes.py failed. Check the Output channel.`);
		}
	});

	context.subscriptions.push(disposableFix);

	const disposableFixPreview = vscode.commands.registerCommand('include-what-you-use-iwyu.fix_preview', async () => {
		const resolved = await resolveActiveEntry(db, outputChannel, { requireSaved: true });
		if (!resolved) return;
		const { editor, entry, workspaceFolder } = resolved;

		outputChannel.clear();
		outputChannel.show(true);

		const result = await runIwyuFixOnEntry(entry, workspaceFolder, outputChannel, true, true);

		if (result.status === 'no-suggestions') {
			vscode.window.showInformationMessage("IWYU: No suggestions to review.");
			return;
		}
		if (result.status === 'failed') {
			vscode.window.showErrorMessage(`fix_includes.py failed. Check the Output channel.`);
			return;
		}

		const fileDiffs = parseFixIncludesDryRun(result.fixStdout);
		if (fileDiffs.length === 0) {
			vscode.window.showInformationMessage("IWYU: No suggestions to review.");
			return;
		}

		// IWYU commonly reports changes for more than just the active file
		// (e.g. its associated header). Apply the active file's diff to the
		// open editor, and open any other affected files to preview theirs.
		const targetPath = normalizePathForCompare(getEntryFilePath(entry));
		let totalHunks = 0;

		for (const fileDiff of fileDiffs) {
			let targetEditor: vscode.TextEditor;

			if (normalizePathForCompare(fileDiff.filename) === targetPath) {
				targetEditor = editor;
			} else {
				let doc: vscode.TextDocument;
				try {
					doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fileDiff.filename));
				} catch (err) {
					outputChannel.appendLine(`IWYU: Could not open ${fileDiff.filename} to preview suggestions: ${err}`);
					continue;
				}
				if (doc.isDirty) {
					vscode.window.showWarningMessage(`IWYU: Skipped suggestions for ${path.basename(fileDiff.filename)} — it has unsaved changes.`);
					continue;
				}
				targetEditor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
			}

			totalHunks += await proposalController.applyProposals(targetEditor, fileDiff);
		}

		if (totalHunks === 0) {
			vscode.window.showInformationMessage("IWYU: No suggestions to review.");
		} else {
			vscode.window.showInformationMessage(`IWYU: ${totalHunks} suggestion(s) ready for review across ${fileDiffs.length} file(s). Use the Accept/Reject CodeLens above each change.`);
		}
	});

	context.subscriptions.push(disposableFixPreview);

	const disposableDryRunFolder = vscode.commands.registerCommand('include-what-you-use-iwyu.dry_run_folder', async (uri?: vscode.Uri) => {
		const targetUri = uri ?? await pickFolderIntegrated();
		if (!targetUri) return;

		const workspaceFolder = vscode.workspace.getWorkspaceFolder(targetUri);
		if (!workspaceFolder) {
			vscode.window.showErrorMessage("Folder is not in a workspace folder.");
			return;
		}

		const entries = db.getAllEntriesInFolder(targetUri);
		if (entries.length === 0) {
			vscode.window.showWarningMessage("IWYU: No compile command found under this folder in compile_commands.json.");
			return;
		}

		outputChannel.clear();
		outputChannel.show(true);
		outputChannel.appendLine(`[IWYU Dry Run] ${entries.length} file(s) under ${targetUri.fsPath}`);

		const reports: string[] = [];

		const completedAll = await runBatch(entries, "IWYU: Dry Run (Folder)", async (entry) => {
			const { report } = await runIwyuDryRunOnEntry(entry, workspaceFolder, outputChannel, false);
			reports.push(report);
			outputChannel.appendLine(report);
			outputChannel.appendLine('---');
		});

		if (completedAll) {
			vscode.window.showInformationMessage(`IWYU: Dry run finished for ${entries.length} file(s).`);

			const config = vscode.workspace.getConfiguration('iwyu');
			const openInNewFile = config.get<boolean>('dryRun.openInNewFile') || false;
			if (openInNewFile) {
				const doc = await vscode.workspace.openTextDocument({ content: reports.join('\n'), language: 'plaintext' });
				await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
			}
		}
	});

	context.subscriptions.push(disposableDryRunFolder);

	const disposableFixFolder = vscode.commands.registerCommand('include-what-you-use-iwyu.fix_folder', async (uri?: vscode.Uri) => {
		const targetUri = uri ?? await pickFolderIntegrated();
		if (!targetUri) return;

		const workspaceFolder = vscode.workspace.getWorkspaceFolder(targetUri);
		if (!workspaceFolder) {
			vscode.window.showErrorMessage("Folder is not in a workspace folder.");
			return;
		}

		const entries = db.getAllEntriesInFolder(targetUri);
		if (entries.length === 0) {
			vscode.window.showWarningMessage("IWYU: No compile command found under this folder in compile_commands.json.");
			return;
		}

		outputChannel.clear();
		outputChannel.show(true);
		outputChannel.appendLine(`[IWYU Fix] ${entries.length} file(s) under ${targetUri.fsPath}`);

		let successCount = 0;
		let failedCount = 0;

		const completedAll = await runBatch(entries, "IWYU: Fix Includes (Folder)", async (entry) => {
			const result = await runIwyuFixOnEntry(entry, workspaceFolder, outputChannel, false);
			outputChannel.appendLine(result.log);
			outputChannel.appendLine('---');
			if (result.status === 'success') successCount++;
			else if (result.status === 'failed') failedCount++;
		});

		if (completedAll) {
			if (failedCount > 0) {
				vscode.window.showWarningMessage(`IWYU Fix: ${successCount} fixed, ${failedCount} failed out of ${entries.length}. Check the Output channel.`);
			} else {
				vscode.window.showInformationMessage(`IWYU Fix: ${successCount} of ${entries.length} file(s) fixed.`);
			}
		}
	});

	context.subscriptions.push(disposableFixFolder);
}

export function deactivate() { }
