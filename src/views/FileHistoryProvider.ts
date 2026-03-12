import * as vscode from 'vscode';
import { GitService } from '../git/GitService';
import { FileHistoryEntry } from '../git/types';

export class FileHistoryProvider implements vscode.TreeDataProvider<FileHistoryEntry>, vscode.Disposable {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private currentFilePath: string | undefined;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly gitService: GitService) {
        const editor = vscode.window.activeTextEditor;
        if (editor?.document.uri.scheme === 'file') {
            this.currentFilePath = editor.document.uri.fsPath;
        }

        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                // Only react to real files — ignore webview panels (editor=undefined),
                // virtual docs (gitlite: scheme), etc. so the history view stays
                // populated when the user opens the commit details panel.
                if (editor?.document.uri.scheme === 'file') {
                    this.currentFilePath = editor.document.uri.fsPath;
                    this._onDidChangeTreeData.fire();
                }
            })
        );
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
            command: 'gitlite.fileHistory.openCommitDetails',
            title: 'Show Commit Details',
            arguments: [entry.sha],
        };
        return item;
    }

    async getChildren(element?: FileHistoryEntry): Promise<FileHistoryEntry[]> {
        if (element) { return []; }
        if (!this.currentFilePath) { return []; }
        try {
            return await this.gitService.getFileHistory(this.currentFilePath);
        } catch {
            return [];
        }
    }

    /** Load history for an explicit file path (e.g. triggered from Hot Files view). */
    loadForFile(filePath: string): void {
        this.currentFilePath = filePath;
        this._onDidChangeTreeData.fire();
    }

    getCurrentFilePath(): string | undefined {
        return this.currentFilePath;
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
        for (const d of this.disposables) { d.dispose(); }
    }
}

function escapeMd(text: string): string {
    return text.replace(/[\\`*_{}[\]()#+\-.!|]/g, '\\$&');
}
