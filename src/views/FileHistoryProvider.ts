import * as vscode from 'vscode';
import { Config } from '../config/Config';
import { GitService } from '../git/GitService';
import { FileHistoryEntry } from '../git/types';

/** Sentinel node rendered at the bottom of a truncated history list. */
interface TruncatedNode { kind: 'truncated'; limit: number; }

type HistoryNode = FileHistoryEntry | TruncatedNode;

export class FileHistoryProvider implements vscode.TreeDataProvider<HistoryNode>, vscode.Disposable {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private currentFilePath: string | undefined;
    private tagsBySha: Map<string, string[]> = new Map();
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly gitService: GitService, private readonly config: Config) {
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

    getTreeItem(node: HistoryNode): vscode.TreeItem {
        if ('kind' in node) {
            // Truncated sentinel
            const item = new vscode.TreeItem(`Showing first ${node.limit} commits — open terminal for full history`);
            item.iconPath = new vscode.ThemeIcon('info');
            return item;
        }
        const entry = node;
        const short = entry.sha.slice(0, 7);
        const item = new vscode.TreeItem(entry.message || '(no message)');
        item.description = `${short} · ${entry.author} · ${entry.relativeDate}`;
        const tags = this.tagsBySha.get(entry.sha) ?? [];
        const tagHtml = tags.map(t => `<span style="color:#e3b341">${escapeMd(t)}</span>`);
        const metaParts = [...tagHtml, short, escapeMd(entry.relativeDate), escapeMd(entry.author)].filter(Boolean);
        item.tooltip = new vscode.MarkdownString(
            `**${escapeMd(entry.message)}**\n\n${metaParts.join(' \u00b7 ')}`
        );
        item.tooltip.isTrusted = true;
        item.contextValue = 'historyEntry';
        item.iconPath = new vscode.ThemeIcon('git-commit');
        item.command = {
            command: 'gitlite.fileHistory.openCommitDetails',
            title: 'Show Commit Details',
            arguments: [entry.sha],
        };
        return item;
    }

    async getChildren(element?: HistoryNode): Promise<HistoryNode[]> {
        if (element) { return []; }
        if (!this.currentFilePath) { return []; }
        try {
            const limit = this.config.historyMaxCommits();
            const [entries, allTags] = await Promise.all([
                this.gitService.getFileHistory(this.currentFilePath, limit),
                this.gitService.getTags(),
            ]);
            this.tagsBySha = new Map();
            for (const t of allTags) {
                const list = this.tagsBySha.get(t.sha) ?? [];
                list.push(t.name);
                this.tagsBySha.set(t.sha, list);
            }
            if (entries.length === limit) {
                return [...entries, { kind: 'truncated', limit } as TruncatedNode];
            }
            return entries;
        } catch (err) {
            console.error('[GitLite] FileHistoryProvider: failed to load file history', err);
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
