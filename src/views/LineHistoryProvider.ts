import * as path from 'path';
import * as vscode from 'vscode';
import { GitService } from '../git/GitService';
import { FileHistoryEntry } from '../git/types';

export class LineHistoryProvider implements vscode.TreeDataProvider<FileHistoryEntry>, vscode.Disposable {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private entries: FileHistoryEntry[] = [];
    private description = 'Run "Show Line History" on a selection';

    constructor(private readonly gitService: GitService) {}

    getTreeItem(entry: FileHistoryEntry): vscode.TreeItem {
        const short = entry.sha.slice(0, 7);
        const item = new vscode.TreeItem(entry.message || '(no message)');
        item.description = `${short} · ${entry.author} · ${entry.relativeDate}`;
        item.tooltip = new vscode.MarkdownString(
            `**${escapeMd(entry.message)}**\n\n${escapeMd(entry.author)} · ${entry.date.toLocaleString()}\n\n\`${short}\``
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

    getChildren(element?: FileHistoryEntry): FileHistoryEntry[] {
        if (element) { return []; }
        return this.entries;
    }

    async loadForSelection(editor: vscode.TextEditor): Promise<void> {
        const { document, selection } = editor;
        if (document.uri.scheme !== 'file') { return; }

        const startLine = selection.start.line + 1; // git log -L is 1-based
        const endLine = selection.end.line + 1;

        vscode.window.withProgress(
            { location: { viewId: 'gitlite.lineHistory' }, title: 'Loading line history…' },
            async () => {
                try {
                    this.entries = await this.gitService.getLineHistory(
                        document.uri.fsPath, startLine, endLine
                    );
                } catch {
                    this.entries = [];
                }
                this.description = `Lines ${startLine}–${endLine} · ${path.basename(document.uri.fsPath)}`;
                this._onDidChangeTreeData.fire();
            }
        );
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}

function escapeMd(text: string): string {
    return text.replace(/[\\`*_{}[\]()#+\-.!|]/g, '\\$&');
}
