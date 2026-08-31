import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface CompileEntry {
	command?: string;
	arguments?: string[];
	directory: string;
	file: string;
}

export class CompilationDatabase implements vscode.Disposable {
	private entries = new Map<string, CompileEntry>();
	private watcher?: vscode.FileSystemWatcher;
	private loadingPromise?: Promise<void>;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private outputChannel: vscode.OutputChannel) {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (folder) {
			this.initWatcher(folder);
			this.loadingPromise = this.loadDatabase(folder);

			this.disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('iwyu.compileCommands.path')) {
					this.initWatcher(folder);
					this.loadingPromise = this.loadDatabase(folder);
				}
			}));
		}
	}

	private getFullDatabasePath(folder: vscode.WorkspaceFolder): string {
		const config = vscode.workspace.getConfiguration('iwyu');
		const configPath = config.get<string>('compileCommands.path') || "";

		let resolvedPath = path.isAbsolute(configPath)
			? configPath
			: path.join(folder.uri.fsPath, configPath);

		if (!resolvedPath.toLowerCase().endsWith('.json')) {
			resolvedPath = path.join(resolvedPath, 'compile_commands.json');
		}

		return resolvedPath;
	}

	private initWatcher(folder: vscode.WorkspaceFolder) {
		this.watcher?.dispose();
		const dbPath = this.getFullDatabasePath(folder);

		this.watcher = vscode.workspace.createFileSystemWatcher(dbPath);
		this.disposables.push(this.watcher);

		const reload = () => { this.loadingPromise = this.loadDatabase(folder); };
		this.watcher.onDidChange(reload);
		this.watcher.onDidCreate(reload);
		this.watcher.onDidDelete(() => this.entries.clear());
	}

	private async loadDatabase(folder: vscode.WorkspaceFolder) {
		const dbPath = this.getFullDatabasePath(folder);

		if (!fs.existsSync(dbPath)) {
			this.outputChannel.appendLine(`[Error] file not found: ${dbPath}`);
			vscode.window.showWarningMessage(`IWYU: compile_commands.json not found at ${dbPath}`);
			return;
		}

		try {
			const content = await fs.promises.readFile(dbPath, 'utf8');
			const data: CompileEntry[] = JSON.parse(content);
			this.entries.clear();

			for (const entry of data) {
				const fullPath = path.resolve(entry.directory, entry.file);
				this.entries.set(vscode.Uri.file(fullPath).toString(), entry);
			}
			this.outputChannel.appendLine(`[DB] Loaded ${this.entries.size} entries.`);
		} catch (err) {
			this.outputChannel.appendLine(`[Error] Failed to load compilation database: ${err}`);
			vscode.window.showErrorMessage(`IWYU: Failed to read compile_commands.json. Check Output channel.`);
		}
	}

	public async getEntryForFile(uri: vscode.Uri): Promise<CompileEntry | undefined> {
		await this.loadingPromise;
		return this.entries.get(uri.toString());
	}

	public getAllEntriesInFolder(folderUri: vscode.Uri): CompileEntry[] {
		// Trailing separator so e.g. "C:\foo\bar" doesn't also match a
		// sibling folder like "C:\foo\barbaz".
		const folderPath = folderUri.fsPath.toLowerCase().replace(/[\\/]+$/, '') + path.sep;
		const entries: CompileEntry[] = [];

		for (const [uriStr, entry] of this.entries.entries()) {
			const fileFsPath = vscode.Uri.parse(uriStr).fsPath.toLowerCase();
			if (fileFsPath.startsWith(folderPath)) {
				entries.push(entry);
			}
		}
		return entries;
	}

	public dispose() {
		this.watcher?.dispose();
		this.disposables.forEach(d => d.dispose());
	}
}
