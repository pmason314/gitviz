import * as vscode from 'vscode';
import { Config, DateFormat } from '../config/Config';
import { GitService } from '../git/GitService';
import { BlameInfo } from '../git/types';
import { isBinaryFile } from '../utils/fileUtils';

const UNCOMMITTED_SHA = '0000000000000000000000000000000000000000';
const DEBOUNCE_MS = 80;

/**
 * Renders ghost text at the end of the active line showing blame info.
 * Uses a single TextEditorDecorationType for the "after" pseudo-element.
 *
 * Performance contract:
 *   - On cursor move: O(1) Map lookup; renders in < 5ms when cache is warm.
 *   - On cache miss: clears decoration immediately, fetches in background, renders on resolve.
 *   - All blame fetches go through GitService (which uses BlameCache + concurrency semaphore).
 */
export class InlineBlame implements vscode.Disposable {
    private readonly decorationType: vscode.TextEditorDecorationType;
    private readonly disposables: vscode.Disposable[] = [];
    private debounceTimer: ReturnType<typeof setTimeout> | undefined;
    private enabled: boolean;

    constructor(
        private readonly gitService: GitService,
        private readonly config: Config
    ) {
        this.enabled = config.blameEnabled();

        this.decorationType = vscode.window.createTextEditorDecorationType({
            after: {
                color: new vscode.ThemeColor('editorGhostText.foreground'),
                fontStyle: 'italic',
                margin: '0 0 0 3em',
            },
            rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
        });

        this.disposables.push(
            vscode.window.onDidChangeTextEditorSelection((e) => {
                this.scheduleUpdate(e.textEditor);
            }),
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                if (editor) {
                    this.scheduleUpdate(editor);
                    // Pre-warm blame cache for newly opened file
                    this.preFetch(editor.document);
                }
            }),
            config.onDidChange(() => {
                this.enabled = config.blameEnabled();
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    if (this.enabled) {
                        this.scheduleUpdate(editor);
                    } else {
                        this.clearEditor(editor);
                    }
                }
            })
        );
    }

    toggle(): void {
        this.enabled = !this.enabled;
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return; }
        if (this.enabled) {
            this.scheduleUpdate(editor);
        } else {
            this.clearEditor(editor);
        }
    }

    // Clears the decoration so it re-renders on next cursor move.
    onFileSaved(document: vscode.TextDocument): void {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document === document) {
            this.clearEditor(editor);
            this.scheduleUpdate(editor);
        }
    }

    dispose(): void {
        if (this.debounceTimer !== undefined) {
            clearTimeout(this.debounceTimer);
        }
        this.decorationType.dispose();
        this.disposables.forEach((d) => d.dispose());
    }

    private scheduleUpdate(editor: vscode.TextEditor): void {
        if (this.debounceTimer !== undefined) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.update(editor).catch(() => { /* ignore */ });
        }, DEBOUNCE_MS);
    }

    private async update(editor: vscode.TextEditor): Promise<void> {
        if (!this.enabled) {
            return;
        }

        const document = editor.document;
        if (document.uri.scheme !== 'file') {
            return;
        }

        if (!this.isWithinSizeLimit(document)) {
            this.clearEditor(editor);
            return;
        }

        if (await isBinaryFile(document.uri.fsPath)) {
            this.clearEditor(editor);
            return;
        }

        // Collect unique 0-based line numbers from all cursors
        const lines = [...new Set(editor.selections.map((s) => s.active.line))];

        let blameMap: Map<number, BlameInfo> | undefined;
        try {
            blameMap = await this.gitService.getBlameForFile(document.uri.fsPath);
        } catch {
            this.clearEditor(editor);
            return;
        }

        const decorations: vscode.DecorationOptions[] = [];
        for (const line of lines) {
            const lineNumber = line + 1; // git blame is 1-indexed
            const info = blameMap.get(lineNumber);
            if (!info) { continue; }

            const text = info.sha === UNCOMMITTED_SHA
                ? 'Not yet committed'
                : `   ${formatBlameString(info, this.config.blameFormat(), this.config.blameDate())}`;

            const lineLength = editor.document.lineAt(line).text.length;
            const range = new vscode.Range(line, lineLength, line, lineLength);
            decorations.push({ range, renderOptions: { after: { contentText: text } } });
        }

        if (decorations.length === 0) {
            this.clearEditor(editor);
            return;
        }

        editor.setDecorations(this.decorationType, decorations);
    }

    private clearEditor(editor: vscode.TextEditor): void {
        editor.setDecorations(this.decorationType, []);
    }

    private isWithinSizeLimit(document: vscode.TextDocument): boolean {
        const maxLines = this.config.blameMaxLines();
        const maxBytes = this.config.blameMaxFileSizeKb() * 1024;
        if (document.lineCount > maxLines) { return false; }
        // getText() is expensive on huge files but we only reach here if lineCount is OK
        if (Buffer.byteLength(document.getText()) > maxBytes) { return false; }
        return true;
    }

    private preFetch(document: vscode.TextDocument): void {
        if (!this.enabled || document.uri.scheme !== 'file') { return; }
        if (!this.isWithinSizeLimit(document)) { return; }
        this.gitService.getBlameForFile(document.uri.fsPath).catch(() => { /* ignore */ });
    }
}

/**
 * Replaces tokens in a format string with blame values.
 * Supported tokens: {author}, {authorEmail}, {sha}, {date}, {message|N}
 * {message|N} truncates the commit summary to N characters.
 */
export function formatBlameString(info: BlameInfo, format: string, dateFormat: DateFormat): string {
    return format.replace(/\{(\w+)(?:\|(\d+))?\}/g, (_match, token: string, maxLen?: string) => {
        switch (token) {
            case 'author': return info.author;
            case 'authorEmail': return info.authorEmail;
            case 'sha': return info.sha.slice(0, 7);
            case 'date': return formatDate(info.authorDate, dateFormat);
            case 'message': {
                const msg = info.summary;
                const limit = maxLen ? parseInt(maxLen, 10) : undefined;
                return limit !== undefined && msg.length > limit
                    ? msg.slice(0, limit) + '…'
                    : msg;
            }
            default: return _match;
        }
    });
}

function formatDate(date: Date, format: DateFormat): string {
    switch (format) {
        case 'relative': return relativeTime(date);
        case 'iso': return date.toISOString().slice(0, 10);
        case 'absolute':
        default:
            return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }
}

export function relativeTime(date: Date): string {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) { return 'just now'; }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) { return `${minutes} minute${minutes === 1 ? '' : 's'} ago`; }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) { return `${hours} hour${hours === 1 ? '' : 's'} ago`; }
    const days = Math.floor(hours / 24);
    if (days < 30) { return `${days} day${days === 1 ? '' : 's'} ago`; }
    const months = Math.floor(days / 30);
    if (months < 12) { return `${months} month${months === 1 ? '' : 's'} ago`; }
    const years = Math.floor(months / 12);
    return `${years} year${years === 1 ? '' : 's'} ago`;
}
