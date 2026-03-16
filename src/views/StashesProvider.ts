import * as vscode from 'vscode';
import { GitService } from '../git/GitService';
import { StashInfo } from '../git/types';

type StashNode = StashInfo & { contextValue: 'stash' };

export class StashesProvider
    implements vscode.TreeDataProvider<StashNode>, vscode.Disposable {

    private readonly _onDidChangeTreeData = new vscode.EventEmitter<StashNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private stashes: StashNode[] = [];

    constructor(private readonly gitService: GitService) {}

    async refresh(): Promise<void> {
        try {
            const entries = await this.gitService.getStashes();
            this.stashes = entries.map(s => ({ ...s, contextValue: 'stash' as const }));
        } catch (err) {
            console.error('[GitViz] StashesProvider: failed to load stashes', err);
            this.stashes = [];
        }
        this._onDidChangeTreeData.fire();
    }

    // -------------------------------------------------------------------------
    // TreeDataProvider
    // -------------------------------------------------------------------------

    getTreeItem(element: StashNode): vscode.TreeItem {
        const item = new vscode.TreeItem(element.message, vscode.TreeItemCollapsibleState.None);
        item.description = element.relativeDate;
        const metaParts = [
            element.branch ? `Stashed from \`${element.branch}\`` : undefined,
            element.relativeDate,
        ].filter(Boolean);
        item.tooltip = new vscode.MarkdownString(`**${element.message}**\n\n${metaParts.join(' \u00b7 ')}`);
        item.iconPath = new vscode.ThemeIcon('inbox');
        item.contextValue = 'stash';
        item.command = {
            command: 'gitviz.stash.openDetails',
            title: 'Open Stash Details',
            arguments: [element],
        };
        return item;
    }

    getChildren(element?: StashNode): vscode.ProviderResult<StashNode[]> {
        if (element) { return []; }
        return this.stashes;
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}
