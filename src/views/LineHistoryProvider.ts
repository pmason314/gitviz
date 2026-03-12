import * as path from 'path';
import * as vscode from 'vscode';
import { GitService } from '../git/GitService';
import { FileHistoryEntry } from '../git/types';

const DEBOUNCE_MS = 500;

export class LineHistoryProvider implements vscode.TreeDataProvider<FileHistoryEntry>, vscode.Disposable {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private entries: FileHistoryEntry[] = [];
    private currentFilePath: string | undefined;
    private currentLine = -1;
    private debounceTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly gitService: GitService) {
        // Initial load for whatever is already open
        const editor = vscode.window.activeTextEditor;
        if (editor?.document.uri.scheme === 'file') {
            this.scheduleLoad(editor);
        }

        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                if (editor?.document.uri.scheme === 'file') {
                    this.currentLine = -1; // force reload on file switch
                    this.scheduleLoad(editor);
                }
            }),
            vscode.window.onDidChangeTextEditorSelection((e) => {
                if (e.textEditor.document.uri.scheme === 'file') {
                    this.scheduleLoad(e.textEditor);
                }
            })
        );
    }

    private scheduleLoad(editor: vscode.TextEditor): void {
        const line = editor.selection.active.line + 1; // 1-based
        const filePath = editor.document.uri.fsPath;
        // Skip if nothing changed
        if (filePath === this.currentFilePath && line === this.currentLine) { return; }

        if (this.debounceTimer !== undefined) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = undefined;
            this.load(filePath, line).catch(() => {/* ignore */});
        }, DEBOUNCE_MS);
    }

    private async load(filePath: string, line: number): Promise<void> {
        this.currentFilePath = filePath;
        this.currentLine = line;
        try {
            this.entries = await this.gitService.getLineHistory(filePath, line, line);
        } catch {
            this.entries = [];
        }
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(entry: FileHistoryEntry): vscode.TreeItem {
        const short = entry.sha.slice(0, 7);
        const item = new vscode.TreeItem(entry.message || '(no message)');
        item.description = `${short} · ${entry.author} · ${entry.relativeDate}`;
        item.tooltip = new vscode.MarkdownString(
            `**${escapeMd(entry.message)}**\n\n${short} · ${escapeMd(entry.relativeDate)} · ${escapeMd(entry.author)}`
        );
        item.contextValue = 'historyEntry';
        item.iconPath = new vscode.ThemeIcon('git-commit');
        item.command = {
            command: 'gitlite.lineHistory.openDiff',
            title: 'Open Diff',
            arguments: [entry.sha],
        };
        return item;
    }

    getChildren(element?: FileHistoryEntry): FileHistoryEntry[] {
        if (element) { return []; }
        return this.entries;
    }

    getCurrentFilePath(): string | undefined {
        return this.currentFilePath;
    }

    getCurrentLine(): number {
        return this.currentLine; // 1-based
    }

    dispose(): void {
        if (this.debounceTimer !== undefined) { clearTimeout(this.debounceTimer); }
        this._onDidChangeTreeData.dispose();
        for (const d of this.disposables) { d.dispose(); }
    }
}

function escapeMd(text: string): string {
    return text.replace(/[\\`*_{}[\]()#+\-.!|]/g, '\\$&');
}
