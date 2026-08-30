import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import { CompilationDatabase, CompileEntry } from './compilationDatabase';

// --- Utils ---

/**
 * Returns the raw compiler command line for a compile_commands.json entry,
 * whether it was stored as a `command` string or an `arguments` array.
 */
function getEntryCommand(entry: CompileEntry): string {
	return entry.command ?? (entry.arguments ? entry.arguments.join(' ') : '');
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

// --- Extension Activation ---

export function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel("Include What You Use");
	const db = new CompilationDatabase(outputChannel);

	context.subscriptions.push(outputChannel, db);

	let disposable = vscode.commands.registerCommand('include-what-you-use-iwyu.dry_run', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;

		const currentFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
		if (!currentFolder) {
			vscode.window.showErrorMessage("File is not in a workspace folder.");
			return;
		}

		const entry = await db.getEntryForFile(editor.document.uri);
		if (!entry) {
			outputChannel.appendLine(`IWYU: No entry found for ${editor.document.uri.fsPath}`);
			vscode.window.showWarningMessage(
				"IWYU: No compile command found for this file. Please ensure your project is configured (e.g., run CMake) and compile_commands.json is up to date."
			);
			return;
		}

		const iwyuExe = getIwyuPath();
		const iwyuArgs = prepareIwyuArgs(getEntryCommand(entry), currentFolder);

		outputChannel.clear();
		outputChannel.appendLine(`[Running IWYU] ${editor.document.uri.fsPath}`);
		outputChannel.appendLine(`[CWD] ${entry.directory}`);
		outputChannel.appendLine(`[Command] ${iwyuExe} ${iwyuArgs.join(' ')}`);
		outputChannel.show(true);

		const process = spawn(iwyuExe, iwyuArgs, {
			cwd: entry.directory,
			shell: false
		});

		const config = vscode.workspace.getConfiguration('iwyu');
		const openInNewFile = config.get<boolean>('dryRun.openInNewFile') || false;
		let report = `[Running IWYU] ${editor.document.uri.fsPath}\n[CWD] ${entry.directory}\n[Command] ${iwyuExe} ${iwyuArgs.join(' ')}\n`;

		process.stdout.on('data', (data) => {
			const chunk = data.toString();
			report += chunk;
			outputChannel.append(chunk);
		});
		process.stderr.on('data', (data) => {
			const chunk = data.toString();
			report += chunk;
			outputChannel.append(chunk);
		});

		process.on('error', (err) => {
			outputChannel.appendLine(`[Error] ${err.message}`);
			vscode.window.showErrorMessage(`IWYU failed to start: ${err.message}`);
		});

		process.on('close', async (code) => {
			report += `\n[Finished] Exit code: ${code}`;
			outputChannel.appendLine(`\n[Finished] Exit code: ${code}`);

			if (openInNewFile) {
				const doc = await vscode.workspace.openTextDocument({ content: report, language: 'plaintext' });
				await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
			}
		});
	});

	context.subscriptions.push(disposable);

	let disposableFix = vscode.commands.registerCommand('include-what-you-use-iwyu.fix', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;

		const currentFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
		if (!currentFolder) {
			vscode.window.showErrorMessage("File is not in a workspace folder.");
			return;
		}

		const entry = await db.getEntryForFile(editor.document.uri);
		if (!entry) {
			outputChannel.appendLine(`IWYU: No entry found for ${editor.document.uri.fsPath}`);
			vscode.window.showWarningMessage(
				"IWYU: No compile command found for this file. Please ensure your project is configured (e.g., run CMake) and compile_commands.json is up to date."
			);
			return;
		}

		const iwyuExe = getIwyuPath();
		const iwyuArgs = prepareIwyuArgs(getEntryCommand(entry), currentFolder);
		const fixIncludesPy = getFixIncludesPath();

		outputChannel.clear();
		outputChannel.appendLine(`[Running IWYU] ${editor.document.uri.fsPath}`);
		outputChannel.appendLine(`[CWD] ${entry.directory}`);
		outputChannel.appendLine(`[Command] ${iwyuExe} ${iwyuArgs.join(' ')}`);
		outputChannel.show(true);

		// 1. Lancer IWYU
		const iwyuProcess = spawn(iwyuExe, iwyuArgs, { cwd: entry.directory });

		let iwyuReport = '';

		// On affiche le résultat de IWYU en temps réel comme pour le Dry Run
		iwyuProcess.stdout.on('data', (data) => {
			const chunk = data.toString();
			iwyuReport += chunk;
			outputChannel.append(chunk);
		});

		iwyuProcess.stderr.on('data', (data) => {
			const chunk = data.toString();
			iwyuReport += chunk;
			outputChannel.append(chunk);
		});

		iwyuProcess.on('close', (code) => {
			outputChannel.appendLine(`\n--- IWYU Raw Report Finished (Exit Code: ${code}) ---`);

			if (iwyuReport.trim().length === 0) {
				outputChannel.appendLine("[Error] IWYU returned no suggestions to process.");
				return;
			}

			const config = vscode.workspace.getConfiguration('iwyu');
			const additionalArgs = config.get<string[]>('fixIncludes.additionalArgs') || [];

			// 2. Préparer fix_includes.py
			const pythonArgs = [
				fixIncludesPy,
				...additionalArgs
			];

			outputChannel.appendLine(`[Running Fix Script]`);
			outputChannel.appendLine(`[CWD] ${entry.directory}`);
			outputChannel.appendLine(`[Command] ${pythonArgs.join(' ')}`);

			// Strip PYTHONHOME/PYTHONPATH: another extension (e.g. the Python
			// extension activating an interpreter) may have set these on the
			// extension host process. Left inherited, they can point Python's
			// stdlib lookup at a different install than the one that actually
			// gets launched, causing an SRE module MAGIC mismatch on import re.
			const fixEnv = { ...process.env };
			delete fixEnv.PYTHONHOME;
			delete fixEnv.PYTHONPATH;

			const fixProcess = spawn('python', pythonArgs, {
				cwd: entry.directory,
				shell: true,
				env: fixEnv
			});

			// Envoyer le rapport IWYU au script Python via STDIN
			fixProcess.stdin.write(iwyuReport);
			fixProcess.stdin.end();

			fixProcess.stdout.on('data', (data) => {
				outputChannel.append(`[fix_includes.py] ${data.toString()}`);
			});

			fixProcess.stderr.on('data', (data) => {
				outputChannel.append(`[fix_includes.py ERR] ${data.toString()}`);
			});

			fixProcess.on('close', (fixCode) => {
				outputChannel.appendLine(`\n[Finished] Fix script exited with code: ${fixCode}`);

				if (fixCode === 0) {
					vscode.window.showInformationMessage("IWYU: Fix applied! Reverting file to load changes...");
					// Optionnel : Recharger le fichier pour voir les changements immédiatement
					vscode.commands.executeCommand('workbench.action.files.revert');
				} else {
					vscode.window.showErrorMessage(`fix_includes.py failed with code ${fixCode}`);
				}
			});

			fixProcess.on('error', (err) => {
				outputChannel.appendLine(`[Error] Could not start fix_includes.py: ${err.message}`);
			});
		});
	});

	context.subscriptions.push(disposableFix);
}

export function deactivate() { }