import * as path from 'path';
import * as vscode from 'vscode';
import { GitService } from '../git/GitService';
import { HotFileEntry } from '../git/types';

export type Timeframe = 7 | 30 | 90 | null;

const TIMEFRAME_LABELS: { [K in string]: string } = {
    '7':    'Last 7 days',
    '30':   'Last 30 days',
    '90':   'Last 90 days',
    'null': 'All time',
};

export class HotFilesProvider implements vscode.TreeDataProvider<HotFileEntry>, vscode.Disposable {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private timeframe: Timeframe = 30;

    constructor(private readonly gitService: GitService) {}

    getTreeItem(entry: HotFileEntry): vscode.TreeItem {
        const fileName = path.basename(entry.path);
        const dirPath = path.dirname(entry.path);

        const item = new vscode.TreeItem(fileName);
        const dirLabel = dirPath !== '.' ? ` · ${dirPath}` : '';
        item.description = `${entry.count} commits${dirLabel}`;
        item.tooltip = `${entry.path}\n${entry.count} commits · top contributor: ${entry.topAuthor || 'unknown'}`;
        item.contextValue = 'hotFile';
        item.iconPath = new vscode.ThemeIcon('file');
        item.resourceUri = vscode.Uri.file(
            path.join(this.gitService.getRepoRoot(), entry.path)
        );
        item.command = {
            command: 'vscode.open',
            title: 'Open File',
            arguments: [item.resourceUri],
        };
        return item;
    }

    async getChildren(element?: HotFileEntry): Promise<HotFileEntry[]> {
        if (element) { return []; }
        const since = this.timeframe
            ? new Date(Date.now() - this.timeframe * 24 * 60 * 60 * 1000)
            : null;
        try {
            return await this.gitService.getHotFiles(since);
        } catch {
            return [];
        }
    }

    getTimeframeLabel(): string {
        return TIMEFRAME_LABELS[String(this.timeframe)] ?? 'Last 30 days';
    }

    setTimeframe(t: Timeframe): void {
        this.timeframe = t;
        this._onDidChangeTreeData.fire();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}
