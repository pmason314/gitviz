import * as path from 'path';
import * as vscode from 'vscode';
import { GitService } from '../git/GitService';
import { HotFileEntry } from '../git/types';

export type Timeframe = 7 | 30 | 90 | null;

/** URI scheme used to attach heat decorations to tree items. */
export const HOT_SCHEME = 'gitviz-hot';

/** Sentinel item rendered when the query returns no results. */
const EMPTY_ENTRY = { _empty: true } as const;
type EmptyEntry = typeof EMPTY_ENTRY;
type TreeEntry = HotFileEntry | EmptyEntry;

function isEmptyEntry(x: TreeEntry): x is EmptyEntry {
    return (x as EmptyEntry)._empty === true;
}

export const TIMEFRAME_LABELS: Record<string, string> = {
    '7':    'Last 7 days',
    '30':   'Last 30 days',
    '90':   'Last 90 days',
    'null': 'All time',
};

/**
 * Matches a relative file path against a filter string.
 * Supports:
 *   - `**` — any sequence of characters including path separators
 *   - `*`  — any sequence of characters within a single path segment
 *   - `?`  — any single character (not a separator)
 *   - plain text — case-insensitive substring match
 */
function matchesFilter(filePath: string, filter: string): boolean {
    if (!filter) { return true; }
    const normalized = filePath.replace(/\\/g, '/');
    if (!/[*?]/.test(filter)) {
        return normalized.toLowerCase().includes(filter.toLowerCase());
    }
    const reSource = filter
        .replace(/\\/g, '/')
        .replace(/[.+^${}()|[\]]/g, '\\$&')   // escape regex special chars (not * ? /)
        .replace(/\*\*/g, '\x00')              // placeholder for **
        .replace(/\*/g, '[^/]*')               // * = within one segment
        .replace(/\?/g, '[^/]')                // ? = single non-separator char
        .replace(/\x00/g, '.*');               // ** = anything
    return new RegExp(reSource, 'i').test(normalized);
}

/**
 * FileDecorationProvider that colours file labels in the Hot Files view.
 * Only responds to URIs with the `gitviz-hot:` scheme; the authority
 * encodes the heat tier: "high" | "medium" (low gets no decoration).
 */
export class HotFileDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
    private readonly _onChange = new vscode.EventEmitter<vscode.Uri[]>();
    readonly onDidChangeFileDecorations = this._onChange.event;

    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        if (uri.scheme !== HOT_SCHEME) { return undefined; }
        switch (uri.authority) {
            case 'high':   return { color: new vscode.ThemeColor('gitviz.hotFile.heatHigh') };
            case 'medium': return { color: new vscode.ThemeColor('gitviz.hotFile.heatMedium') };
            case 'dim':    return { color: new vscode.ThemeColor('descriptionForeground') };
            default:       return undefined;
        }
    }

    dispose(): void { this._onChange.dispose(); }
}

export class HotFilesProvider implements vscode.TreeDataProvider<TreeEntry>, vscode.Disposable {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private _onActiveTimeframeChanged = new vscode.EventEmitter<string>();
    readonly onActiveTimeframeChanged = this._onActiveTimeframeChanged.event;

    private userTimeframe: Timeframe = 30;
    private filter: string = '';
    private rankMap = new Map<string, number>();
    private totalEntries = 0;

    constructor(private readonly gitService: GitService) {}

    getTreeItem(entry: TreeEntry): vscode.TreeItem {
        if (isEmptyEntry(entry)) {
            const item = new vscode.TreeItem('');
            item.resourceUri = vscode.Uri.from({ scheme: HOT_SCHEME, authority: 'dim', path: '/_empty' });
            if (this.filter) {
                item.description = `No files matching "${this.filter}"`;
                item.tooltip = 'No hot files matched your filter. Try a different path or glob expression.';
            } else {
                item.description = this.userTimeframe
                    ? `No commits found in the last ${this.userTimeframe} days`
                    : 'No commits found';
                item.tooltip = 'No files changed in this timeframe. Try selecting a wider range using the buttons above.';
            }
            return item;
        }

        const fileName = path.basename(entry.path);
        const dirPath = path.dirname(entry.path);

        const idx = this.rankMap.get(entry.path) ?? 0;
        const ratio = this.totalEntries > 1 ? idx / (this.totalEntries - 1) : 0;
        const heatTier = ratio < 0.25 ? 'high' : ratio < 0.6 ? 'medium' : 'none';

        const item = new vscode.TreeItem(fileName);
        const dirLabel = dirPath !== '.' ? ` · ${dirPath}` : '';
        item.description = `${entry.count} commits${dirLabel}`;
        item.tooltip = `${entry.path}\n${entry.count} commits · top contributor: ${entry.topAuthor || 'unknown'}`;
        item.contextValue = 'hotFile';

        // resourceUri uses the heat scheme so our FileDecorationProvider colours the label.
        // The open command explicitly passes the real file URI.
        item.resourceUri = vscode.Uri.from({
            scheme: HOT_SCHEME,
            authority: heatTier,
            path: '/' + entry.path.replace(/\\/g, '/'),
        });
        const absUri = vscode.Uri.file(path.join(this.gitService.getRepoRoot(), entry.path));
        item.command = { command: 'vscode.open', title: 'Open File', arguments: [absUri] };
        return item;
    }

    async getChildren(element?: TreeEntry): Promise<TreeEntry[]> {
        if (element) { return []; }

        const since = this.userTimeframe
            ? new Date(Date.now() - this.userTimeframe * 24 * 60 * 60 * 1000)
            : null;
        try {
            const results = await this.gitService.getHotFiles(since);
            const filtered = this.filter
                ? results.filter(e => matchesFilter(e.path, this.filter))
                : results;
            this.rankMap.clear();
            filtered.forEach((e, i) => this.rankMap.set(e.path, i));
            this.totalEntries = filtered.length;
            return filtered.length > 0 ? filtered : [EMPTY_ENTRY];
        } catch {
            return [EMPTY_ENTRY];
        }
    }

    getActiveTimeframeLabel(): string { return TIMEFRAME_LABELS[String(this.userTimeframe)]; }
    getFilter(): string { return this.filter; }

    setTimeframe(t: Timeframe): void {
        this.userTimeframe = t;
        this._onActiveTimeframeChanged.fire(TIMEFRAME_LABELS[String(t)]);
        this._onDidChangeTreeData.fire();
    }

    setFilter(glob: string): void {
        this.filter = glob.trim();
        this._onDidChangeTreeData.fire();
    }

    clearFilter(): void {
        this.filter = '';
        this._onDidChangeTreeData.fire();
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
        this._onActiveTimeframeChanged.dispose();
    }
}
