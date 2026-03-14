import * as path from 'path';
import * as vscode from 'vscode';
import { Config } from '../config/Config';
import { GitService } from '../git/GitService';
import { FileHistoryEntry } from '../git/types';

const DEBOUNCE_MS = 500;

/** Sentinel node rendered at the bottom of a truncated history list. */
interface TruncatedNode { kind: 'truncated'; limit: number; }

/** Sentinel node shown while a debounced async load is in progress. */
interface LoadingNode { kind: 'loading'; }

type LineHistoryNode = FileHistoryEntry | TruncatedNode | LoadingNode;

export class LineHistoryProvider implements vscode.TreeDataProvider<LineHistoryNode>, vscode.Disposable {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private entries: LineHistoryNode[] = [];
    private tagsBySha: Map<string, string[]> = new Map();
    private loading = false;
    private currentFilePath: string | undefined;
    private currentLine = -1;
    private debounceTimer: ReturnType<typeof setTimeout> | undefined;
    private loadGeneration = 0;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly gitService: GitService, private readonly config: Config) {
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
        // Show loading state immediately so stale entries don't linger
        this.loading = true;
        this._onDidChangeTreeData.fire();
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = undefined;
            this.load(filePath, line).catch((err) => {
                console.error('[GitViz] LineHistoryProvider: unhandled error in load', err);
            });
        }, DEBOUNCE_MS);
    }

    private async load(filePath: string, line: number): Promise<void> {
        this.currentFilePath = filePath;
        this.currentLine = line;
        const generation = ++this.loadGeneration;
        const limit = this.config.historyMaxCommits();
        try {
            const [raw, allTags] = await Promise.all([
                this.gitService.getLineHistory(filePath, line, line, limit),
                this.gitService.getTags(),
            ]);
            // Discard results if a newer load was triggered while we were awaiting
            if (generation !== this.loadGeneration) { return; }
            this.tagsBySha = new Map();
            for (const t of allTags) {
                const list = this.tagsBySha.get(t.sha) ?? [];
                list.push(t.name);
                this.tagsBySha.set(t.sha, list);
            }
            if (raw.length === limit) {
                this.entries = [...raw, { kind: 'truncated', limit } as TruncatedNode];
            } else {
                this.entries = raw;
            }
        } catch (err) {
            if (generation !== this.loadGeneration) { return; }
            console.error('[GitViz] LineHistoryProvider: failed to load line history', err);
            this.entries = [];
        }
        this.loading = false;
        this._onDidChangeTreeData.fire();
    }

    /** Re-run the current line history query (e.g. after a pull brings in new commits). */
    refresh(): void {
        if (this.currentFilePath && this.currentLine > 0) {
            void this.load(this.currentFilePath, this.currentLine);
        }
    }

    getTreeItem(node: LineHistoryNode): vscode.TreeItem {
        if ('kind' in node) {
            if (node.kind === 'loading') {
                const item = new vscode.TreeItem('Loading…');
                item.iconPath = new vscode.ThemeIcon('loading~spin');
                return item;
            }
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
            command: 'gitviz.lineHistory.openDiff',
            title: 'Open Diff',
            arguments: [entry.sha],
        };
        return item;
    }

    getChildren(element?: LineHistoryNode): LineHistoryNode[] {
        if (element) { return []; }
        if (this.loading) {
            return [{ kind: 'loading' }];
        }
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
