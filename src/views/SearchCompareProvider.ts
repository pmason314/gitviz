import * as vscode from 'vscode';
import { GitService } from '../git/GitService';
import { CommitEntry } from '../git/types';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type SearchType = 'message' | 'author' | 'content';

type Mode =
    | { kind: 'idle' }
    | { kind: 'search'; query: string; type: SearchType }
    | { kind: 'compare'; from: string; to: string };

// ---------------------------------------------------------------------------
// Node types
// ---------------------------------------------------------------------------

interface PlaceholderNode {
    kind: 'placeholder';
    label: string;
    description?: string;
}

interface CommitNode {
    kind: 'commit';
    entry: CommitEntry;
}

interface HeaderNode {
    kind: 'header';
    label: string;
}

type SearchCompareNode = PlaceholderNode | CommitNode | HeaderNode;

const SEARCH_TYPE_LABELS: Record<SearchType, string> = {
    message: 'Commit message',
    author:  'Author name/email',
    content: 'File content (pickaxe)',
};

export class SearchCompareProvider
    implements vscode.TreeDataProvider<SearchCompareNode>, vscode.Disposable {

    private readonly _onDidChangeTreeData =
        new vscode.EventEmitter<SearchCompareNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private mode: Mode = { kind: 'idle' };
    private results: CommitEntry[] = [];
    private loading = false;

    // Exposed so extension.ts can update the view title/description
    private _view?: vscode.TreeView<SearchCompareNode>;
    setView(view: vscode.TreeView<SearchCompareNode>): void {
        this._view = view;
    }

    constructor(private readonly gitService: GitService) {}

    // -------------------------------------------------------------------------
    // Public commands
    // -------------------------------------------------------------------------

    async promptSearch(): Promise<void> {
        const types: vscode.QuickPickItem[] = (
            Object.entries(SEARCH_TYPE_LABELS) as Array<[SearchType, string]>
        ).map(([value, label]) => ({ label, description: value }));

        const picked = await vscode.window.showQuickPick(types, {
            title: 'Search Commits — Search by',
            placeHolder: 'Select what to search',
        });
        if (!picked) { return; }
        const searchType = picked.description as SearchType;

        const query = await vscode.window.showInputBox({
            title: `Search commits by ${picked.label}`,
            placeHolder: 'Enter search term…',
            prompt: picked.label,
        });
        if (!query) { return; }

        this.mode = { kind: 'search', query, type: searchType };
        this._updateTitle();
        await this._load();
    }

    async promptCompare(): Promise<void> {
        const from = await vscode.window.showInputBox({
            title: 'Compare Refs — Base (from)',
            placeHolder: 'Branch, tag, or commit SHA  (e.g. main)',
            prompt: 'Commits NOT in this ref will be shown',
        });
        if (!from) { return; }

        const to = await vscode.window.showInputBox({
            title: 'Compare Refs — Target (to)',
            placeHolder: 'Branch, tag, or commit SHA  (e.g. feature/foo)',
            prompt: `Commits in this ref that are not in "${from}"`,
        });
        if (!to) { return; }

        this.mode = { kind: 'compare', from, to };
        this._updateTitle();
        await this._load();
    }

    clearResults(): void {
        this.mode = { kind: 'idle' };
        this.results = [];
        this._updateTitle();
        this._onDidChangeTreeData.fire();
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    private async _load(): Promise<void> {
        this.loading = true;
        this.results = [];
        this._onDidChangeTreeData.fire();

        try {
            if (this.mode.kind === 'search') {
                this.results = await this.gitService.searchCommits(
                    this.mode.query,
                    this.mode.type,
                );
            } else if (this.mode.kind === 'compare') {
                this.results = await this.gitService.getCommitsBetween(
                    this.mode.from,
                    this.mode.to,
                );
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`GitLite: ${msg}`);
            this.results = [];
        }

        this.loading = false;
        this._onDidChangeTreeData.fire();
    }

    private _updateTitle(): void {
        if (!this._view) { return; }
        if (this.mode.kind === 'idle') {
            this._view.description = undefined;
        } else if (this.mode.kind === 'search') {
            this._view.description = `"${this.mode.query}"`;
        } else {
            this._view.description = `${this.mode.from}..${this.mode.to}`;
        }
    }

    // -------------------------------------------------------------------------
    // TreeDataProvider
    // -------------------------------------------------------------------------

    getTreeItem(element: SearchCompareNode): vscode.TreeItem {
        if (element.kind === 'placeholder') {
            const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
            if (element.description) { item.description = element.description; }
            item.contextValue = 'placeholder';
            return item;
        }

        if (element.kind === 'header') {
            const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
            item.contextValue = 'searchHeader';
            return item;
        }

        // commit
        const e = element.entry;
        const item = new vscode.TreeItem(
            e.message || '(no message)',
            vscode.TreeItemCollapsibleState.None,
        );
        item.description = `${e.sha.slice(0, 7)}  ${e.relativeDate}  ${e.author}`;
        item.tooltip = new vscode.MarkdownString(
            `**${e.message}**\n\n` +
            `SHA: \`${e.sha}\`\n\n` +
            `Author: ${e.author}\n\n` +
            `Date: ${e.date.toLocaleString()}`
        );
        item.iconPath = new vscode.ThemeIcon('git-commit');
        item.contextValue = 'commit';
        item.command = {
            command: 'gitlite.openCommitDetails',
            title: 'Open Commit Details',
            arguments: [e.sha],
        };
        return item;
    }

    getChildren(element?: SearchCompareNode): vscode.ProviderResult<SearchCompareNode[]> {
        if (element) { return []; }

        if (this.loading) {
            return [{ kind: 'placeholder', label: 'Loading…' }];
        }

        if (this.mode.kind === 'idle') {
            return [
                {
                    kind: 'placeholder',
                    label: 'Search commits by message, author, or content',
                    description: 'Use $(search) to search',
                },
                {
                    kind: 'placeholder',
                    label: 'Compare two refs',
                    description: 'Use $(git-compare) to compare',
                },
            ];
        }

        if (this.results.length === 0) {
            return [{ kind: 'placeholder', label: 'No results found' }];
        }

        let header: HeaderNode;
        if (this.mode.kind === 'search') {
            const typeLabel = SEARCH_TYPE_LABELS[this.mode.type];
            header = {
                kind: 'header',
                label: `${this.results.length} result${this.results.length === 1 ? '' : 's'} — ${typeLabel}: "${this.mode.query}"`,
            };
        } else {
            header = {
                kind: 'header',
                label: `${this.results.length} commit${this.results.length === 1 ? '' : 's'} in ${this.mode.from}..${this.mode.to}`,
            };
        }

        return [
            header,
            ...this.results.map(e => ({ kind: 'commit' as const, entry: e })),
        ];
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}
