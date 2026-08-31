export type DiffLineType = 'context' | 'add' | 'remove';

export interface DiffLine {
	type: DiffLineType;
	text: string;
}

export interface DiffHunk {
	oldStart: number;
	newStart: number;
	lines: DiffLine[];
}

export interface FileDiff {
	filename: string;
	hunks: DiffHunk[];
}

const FILE_HEADER_RE = /^>>> Fixing #includes in '(.*)'$/;
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@$/;
const NO_CHANGES_RE = /^No changes in file /;
const SUMMARY_RE = /^IWYU edited \d+ files on your behalf\.$/;

/**
 * Parses the stdout of `fix_includes.py --dry_run`.
 *
 * fix_includes.py prints, per file, a `>>> Fixing #includes in '<file>'`
 * marker followed either by `No changes in file <file>` or a unified diff
 * (via Python's difflib.unified_diff, with the `---`/`+++` header lines
 * already stripped) made of `@@ -a,b +c,d @@` hunk headers and ` `/`+`/`-`
 * prefixed lines.
 */
export function parseFixIncludesDryRun(stdout: string): FileDiff[] {
	// Python's stdout uses universal-newline translation on Windows, so the
	// child process's output is CRLF-terminated there even though it never
	// prints '\r' itself. Normalize before splitting, otherwise every line
	// keeps a trailing '\r' that breaks the '$'-anchored regexes below.
	const lines = stdout.replace(/\r\n/g, '\n').split('\n');
	const files: FileDiff[] = [];

	let currentFile: FileDiff | null = null;
	let currentHunk: DiffHunk | null = null;

	const flushHunk = () => {
		if (currentHunk && currentFile) {
			currentFile.hunks.push(currentHunk);
		}
		currentHunk = null;
	};

	for (const rawLine of lines) {
		const fileMatch = FILE_HEADER_RE.exec(rawLine);
		if (fileMatch) {
			flushHunk();
			currentFile = { filename: fileMatch[1], hunks: [] };
			files.push(currentFile);
			continue;
		}

		if (SUMMARY_RE.test(rawLine)) {
			// The trailing "IWYU edited N files on your behalf." summary
			// unambiguously ends the last file's diff.
			flushHunk();
			currentFile = null;
			continue;
		}

		if (!currentFile) {
			continue;
		}

		if (NO_CHANGES_RE.test(rawLine)) {
			flushHunk();
			continue;
		}

		const hunkMatch = HUNK_HEADER_RE.exec(rawLine);
		if (hunkMatch) {
			flushHunk();
			currentHunk = {
				oldStart: parseInt(hunkMatch[1], 10),
				newStart: parseInt(hunkMatch[2], 10),
				lines: []
			};
			continue;
		}

		if (!currentHunk) {
			continue;
		}

		const prefix = rawLine.charAt(0);
		if (prefix === '+') {
			currentHunk.lines.push({ type: 'add', text: rawLine.slice(1) });
		} else if (prefix === '-') {
			currentHunk.lines.push({ type: 'remove', text: rawLine.slice(1) });
		} else if (prefix === ' ') {
			currentHunk.lines.push({ type: 'context', text: rawLine.slice(1) });
		} else {
			// An unchanged blank line: difflib prefixes it with a single
			// space, but fix_includes.py's `line.rstrip()` (applied before
			// printing) strips that space along with the line's own
			// trailing newline, since the whole line is whitespace. What's
			// left here is an empty string — still a context line.
			currentHunk.lines.push({ type: 'context', text: rawLine });
		}
	}

	flushHunk();

	return files.filter(f => f.hunks.length > 0);
}
