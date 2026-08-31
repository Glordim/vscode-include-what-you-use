import * as vscode from 'vscode';
import * as path from 'path';
import { FileDiff } from './diff';

interface PendingHunk {
	id: number;
	anchorLine: number;
	lineCount: number;
	removedRanges: vscode.Range[];
	addedRanges: vscode.Range[];
}

interface FileProposalState {
	hunks: PendingHunk[];
	acceptedCount: number;
	rejectedCount: number;
	applyingOwnEdit: boolean;
}

function fullLineRange(line: number): vscode.Range {
	return new vscode.Range(line, 0, line + 1, 0);
}

/**
 * `removedRanges`/`addedRanges` span from a line's start to the start of
 * the *next* line (so deleting them on accept/reject also removes the
 * trailing newline). But with `isWholeLine: true`, VS Code decorates every
 * line a range touches — including one whose only overlap is that
 * zero-width endpoint at column 0. Left as-is, the line right after a
 * removed block inherits the "removed" strikethrough. Collapse to the
 * range's start line only when building decoration ranges.
 */
function toDecorationRange(range: vscode.Range): vscode.Range {
	return new vscode.Range(range.start.line, 0, range.start.line, 0);
}

function shiftRange(range: vscode.Range, delta: number): vscode.Range {
	return new vscode.Range(
		range.start.line + delta, range.start.character,
		range.end.line + delta, range.end.character
	);
}

/**
 * Renders IWYU's proposed #include changes inline (strikethrough for
 * removed lines, highlighted for added lines) and lets the user accept or
 * reject each hunk via CodeLens, instead of applying fix_includes.py's
 * changes to disk immediately.
 */
export class ProposalController implements vscode.CodeLensProvider, vscode.Disposable {
	private readonly states = new Map<string, FileProposalState>();

	private readonly removedDecoration = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		textDecoration: 'line-through',
		backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground')
	});

	private readonly addedDecoration = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground')
	});

	private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
	public readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

	public register(context: vscode.ExtensionContext): void {
		context.subscriptions.push(
			vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this),
			vscode.commands.registerCommand('include-what-you-use-iwyu.internal.acceptHunk',
				(uri: vscode.Uri, hunkId: number) => this.resolveHunk(uri, hunkId, true)),
			vscode.commands.registerCommand('include-what-you-use-iwyu.internal.rejectHunk',
				(uri: vscode.Uri, hunkId: number) => this.resolveHunk(uri, hunkId, false)),
			vscode.commands.registerCommand('include-what-you-use-iwyu.internal.acceptAll',
				(uri: vscode.Uri) => this.resolveAll(uri, true)),
			vscode.commands.registerCommand('include-what-you-use-iwyu.internal.rejectAll',
				(uri: vscode.Uri) => this.resolveAll(uri, false)),
			vscode.window.onDidChangeVisibleTextEditors(editors => {
				for (const editor of editors) {
					if (this.states.has(editor.document.uri.toString())) {
						this.refreshDecorations(editor.document.uri);
					}
				}
			}),
			vscode.workspace.onDidChangeTextDocument(e => {
				if (e.contentChanges.length === 0) return;
				const state = this.states.get(e.document.uri.toString());
				if (!state || state.applyingOwnEdit) return;
				this.handleForeignEdit(e.document.uri, e.contentChanges);
			}),
			vscode.workspace.onDidCloseTextDocument(doc => {
				if (this.states.has(doc.uri.toString())) {
					this.clearState(doc.uri, false);
				}
			}),
			vscode.workspace.onDidSaveTextDocument(doc => {
				const state = this.states.get(doc.uri.toString());
				if (state && state.hunks.length > 0) {
					vscode.window.showWarningMessage(
						`IWYU: ${path.basename(doc.uri.fsPath)} was saved with ${state.hunks.length} pending suggestion(s) still shown ` +
						`— the file may contain duplicate #include lines. Resolve the remaining suggestions and save again.`
					);
				}
			}),
			this
		);
	}

	/**
	 * Inserts the proposed lines for every hunk of `fileDiff` into the live
	 * buffer and decorates them for review. Returns the number of hunks
	 * shown (0 if the file had no changes).
	 */
	public async applyProposals(editor: vscode.TextEditor, fileDiff: FileDiff): Promise<number> {
		const uri = editor.document.uri;
		const key = uri.toString();

		this.clearState(uri, false);

		if (fileDiff.hunks.length === 0) {
			return 0;
		}

		const eol = editor.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
		const edit = new vscode.WorkspaceEdit();

		const hunks: PendingHunk[] = [];
		let cumulativeOffset = 0;
		let nextId = 0;

		for (const hunk of fileDiff.hunks) {
			const oldCount = hunk.lines.filter(l => l.type !== 'add').length;
			const startLine = hunk.oldStart - 1;
			const originalRange = new vscode.Range(startLine, 0, startLine + oldCount, 0);
			const replacementText = hunk.lines.map(l => l.text + eol).join('');
			edit.replace(uri, originalRange, replacementText);

			// A diff hunk is one contiguous region difflib grouped together
			// (with up to 3 lines of context around each change), but it can
			// bundle several unrelated add/remove groups. Split it into one
			// independently accept/reject-able PendingHunk per maximal run
			// of consecutive remove/add lines, so reviewing one doesn't
			// force an all-or-nothing decision on the others.
			let cursor = startLine + cumulativeOffset;
			let currentGroup: { anchorLine: number, removedRanges: vscode.Range[], addedRanges: vscode.Range[] } | null = null;

			const closeGroup = () => {
				if (!currentGroup) return;
				hunks.push({
					id: nextId++,
					anchorLine: currentGroup.anchorLine,
					lineCount: currentGroup.removedRanges.length + currentGroup.addedRanges.length,
					removedRanges: currentGroup.removedRanges,
					addedRanges: currentGroup.addedRanges
				});
				currentGroup = null;
			};

			for (const line of hunk.lines) {
				if (line.type === 'context') {
					closeGroup();
				} else {
					if (!currentGroup) {
						currentGroup = { anchorLine: cursor, removedRanges: [], addedRanges: [] };
					}
					const lineRange = fullLineRange(cursor);
					if (line.type === 'remove') {
						currentGroup.removedRanges.push(lineRange);
					} else {
						currentGroup.addedRanges.push(lineRange);
					}
				}
				cursor++;
			}
			closeGroup();

			cumulativeOffset += hunk.lines.filter(l => l.type === 'add').length;
		}

		const state: FileProposalState = { hunks, acceptedCount: 0, rejectedCount: 0, applyingOwnEdit: true };
		this.states.set(key, state);

		try {
			await vscode.workspace.applyEdit(edit);
		} finally {
			state.applyingOwnEdit = false;
		}

		this.refreshDecorations(uri);
		this.onDidChangeCodeLensesEmitter.fire();

		return hunks.length;
	}

	public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const state = this.states.get(document.uri.toString());
		if (!state || state.hunks.length === 0) return [];

		const lenses: vscode.CodeLens[] = [];

		if (state.hunks.length > 1) {
			const topLine = Math.min(...state.hunks.map(h => h.anchorLine));
			const range = new vscode.Range(topLine, 0, topLine, 0);
			lenses.push(new vscode.CodeLens(range, {
				title: `Accept All (${state.hunks.length})`,
				command: 'include-what-you-use-iwyu.internal.acceptAll',
				arguments: [document.uri]
			}));
			lenses.push(new vscode.CodeLens(range, {
				title: `Reject All (${state.hunks.length})`,
				command: 'include-what-you-use-iwyu.internal.rejectAll',
				arguments: [document.uri]
			}));
		}

		for (const hunk of state.hunks) {
			const range = new vscode.Range(hunk.anchorLine, 0, hunk.anchorLine, 0);
			lenses.push(new vscode.CodeLens(range, {
				title: '$(check) Accept',
				command: 'include-what-you-use-iwyu.internal.acceptHunk',
				arguments: [document.uri, hunk.id]
			}));
			lenses.push(new vscode.CodeLens(range, {
				title: '$(close) Reject',
				command: 'include-what-you-use-iwyu.internal.rejectHunk',
				arguments: [document.uri, hunk.id]
			}));
		}

		return lenses;
	}

	private async resolveHunk(uri: vscode.Uri, hunkId: number, accept: boolean): Promise<void> {
		const key = uri.toString();
		const state = this.states.get(key);
		if (!state) return;

		const idx = state.hunks.findIndex(h => h.id === hunkId);
		if (idx === -1) return;
		const hunk = state.hunks[idx];

		const losingRanges = accept ? hunk.removedRanges : hunk.addedRanges;
		const deltaLines = losingRanges.length;

		const edit = new vscode.WorkspaceEdit();
		for (const r of losingRanges) edit.delete(uri, r);

		state.applyingOwnEdit = true;
		try {
			await vscode.workspace.applyEdit(edit);
		} finally {
			state.applyingOwnEdit = false;
		}

		state.hunks.splice(idx, 1);
		if (accept) state.acceptedCount++; else state.rejectedCount++;

		if (deltaLines > 0) {
			for (const h of state.hunks) {
				if (h.anchorLine > hunk.anchorLine) {
					h.anchorLine -= deltaLines;
					h.removedRanges = h.removedRanges.map(r => shiftRange(r, -deltaLines));
					h.addedRanges = h.addedRanges.map(r => shiftRange(r, -deltaLines));
				}
			}
		}

		if (state.hunks.length === 0) {
			this.finishReview(uri, state);
		} else {
			this.refreshDecorations(uri);
			this.onDidChangeCodeLensesEmitter.fire();
		}
	}

	private async resolveAll(uri: vscode.Uri, accept: boolean): Promise<void> {
		const key = uri.toString();
		const state = this.states.get(key);
		if (!state) return;

		const edit = new vscode.WorkspaceEdit();
		for (const hunk of state.hunks) {
			for (const r of (accept ? hunk.removedRanges : hunk.addedRanges)) {
				edit.delete(uri, r);
			}
		}

		state.applyingOwnEdit = true;
		try {
			await vscode.workspace.applyEdit(edit);
		} finally {
			state.applyingOwnEdit = false;
		}

		if (accept) state.acceptedCount += state.hunks.length;
		else state.rejectedCount += state.hunks.length;
		state.hunks = [];

		this.finishReview(uri, state);
	}

	private finishReview(uri: vscode.Uri, state: FileProposalState): void {
		this.states.delete(uri.toString());
		this.refreshDecorations(uri);
		this.onDidChangeCodeLensesEmitter.fire();
		vscode.window.showInformationMessage(
			`IWYU: review complete for ${path.basename(uri.fsPath)} — ${state.acceptedCount} accepted, ${state.rejectedCount} rejected.`
		);
	}

	/**
	 * Reacts to an edit the controller didn't make itself. Rather than
	 * discarding the whole preview, only hunks that actually overlap the
	 * edited range(s) are dropped; hunks elsewhere in the file survive,
	 * shifted by the edit's net line delta. `contentChanges` within one
	 * event are all expressed against the document as it was *before* the
	 * event, so every hunk is checked against the original, unshifted
	 * change ranges rather than against progressively updated ones.
	 */
	private handleForeignEdit(uri: vscode.Uri, changes: readonly vscode.TextDocumentContentChangeEvent[]): void {
		const key = uri.toString();
		const state = this.states.get(key);
		if (!state) return;

		const edits = changes.map(c => ({
			startLine: c.range.start.line,
			endLine: c.range.end.line,
			delta: (c.text.split('\n').length - 1) - (c.range.end.line - c.range.start.line)
		}));

		const survivors: PendingHunk[] = [];
		let droppedCount = 0;

		for (const hunk of state.hunks) {
			const hunkStart = hunk.anchorLine;
			const hunkEnd = hunk.anchorLine + hunk.lineCount;

			let overlapped = false;
			let totalDelta = 0;
			for (const e of edits) {
				if (hunkStart < e.endLine && hunkEnd > e.startLine) {
					overlapped = true;
					break;
				}
				if (e.startLine <= hunkStart) {
					totalDelta += e.delta;
				}
			}

			if (overlapped) {
				droppedCount++;
				continue;
			}

			if (totalDelta !== 0) {
				hunk.anchorLine += totalDelta;
				hunk.removedRanges = hunk.removedRanges.map(r => shiftRange(r, totalDelta));
				hunk.addedRanges = hunk.addedRanges.map(r => shiftRange(r, totalDelta));
			}
			survivors.push(hunk);
		}

		state.hunks = survivors;
		if (state.hunks.length === 0) {
			this.states.delete(key);
		}

		this.refreshDecorations(uri);
		this.onDidChangeCodeLensesEmitter.fire();

		if (droppedCount > 0) {
			vscode.window.showWarningMessage(
				`IWYU: ${droppedCount} pending suggestion(s) in ${path.basename(uri.fsPath)} were discarded because that part of the file was edited.`
			);
		}
	}

	private clearState(uri: vscode.Uri, warn: boolean): void {
		const key = uri.toString();
		if (!this.states.has(key)) return;
		this.states.delete(key);
		this.refreshDecorations(uri);
		this.onDidChangeCodeLensesEmitter.fire();
		if (warn) {
			vscode.window.showWarningMessage(
				`IWYU: pending suggestion preview for ${path.basename(uri.fsPath)} was discarded because the file changed.`
			);
		}
	}

	private refreshDecorations(uri: vscode.Uri): void {
		const state = this.states.get(uri.toString());
		const removed = state ? state.hunks.flatMap(h => h.removedRanges.map(toDecorationRange)) : [];
		const added = state ? state.hunks.flatMap(h => h.addedRanges.map(toDecorationRange)) : [];

		for (const editor of vscode.window.visibleTextEditors) {
			if (editor.document.uri.toString() === uri.toString()) {
				editor.setDecorations(this.removedDecoration, removed);
				editor.setDecorations(this.addedDecoration, added);
			}
		}
	}

	public dispose(): void {
		this.removedDecoration.dispose();
		this.addedDecoration.dispose();
		this.onDidChangeCodeLensesEmitter.dispose();
	}
}
