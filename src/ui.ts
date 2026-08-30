import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export async function pickFolderIntegrated(): Promise<vscode.Uri | undefined> {
	const root = vscode.workspace.workspaceFolders?.[0];
	const activeEditor = vscode.window.activeTextEditor;

	let currentPath: string;
	if (activeEditor && !activeEditor.document.isUntitled) {
		currentPath = path.dirname(activeEditor.document.uri.fsPath);
	} else if (root) {
		currentPath = root.uri.fsPath;
	} else {
		return undefined;
	}

	while (true) {
		const items: vscode.QuickPickItem[] = [
			{
				label: "$(check) Select this folder",
				detail: currentPath,
				alwaysShow: true
			},
			{ label: "", kind: vscode.QuickPickItemKind.Separator }
		];

		try {
			const files = await fs.promises.readdir(currentPath, { withFileTypes: true });

			const dirs = files
				.filter(f => f.isDirectory() && !f.name.startsWith('.'))
				.sort((a, b) => a.name.localeCompare(b.name))
				.map(f => ({
					label: "$(folder) " + f.name,
					description: path.join(currentPath, f.name)
				}));

			const parentDir = path.dirname(currentPath);
			if (parentDir !== currentPath) {
				items.push({
					label: "$(arrow-left) Go back",
					description: parentDir
				});
			}

			items.push(...dirs);

			const selection = await vscode.window.showQuickPick(items, {
				placeHolder: `Currently in: ${path.basename(currentPath) || currentPath}`,
				ignoreFocusOut: true,
				matchOnDescription: true
			});

			if (!selection) { return undefined; }

			if (selection.label === "$(check) Select this folder") {
				return vscode.Uri.file(currentPath);
			} else {
				currentPath = selection.description!;
			}
		} catch (err) {
			vscode.window.showErrorMessage(`Error reading folder: ${err}`);
			return undefined;
		}
	}
}
