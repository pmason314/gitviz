import * as vscode from 'vscode';
import { GitService } from '../git/GitService';
import { TagInfo } from '../git/types';

type TagNode = TagInfo & { contextValue: 'tag' };

export class TagsProvider
    implements vscode.TreeDataProvider<TagNode>, vscode.Disposable {

    private readonly _onDidChangeTreeData = new vscode.EventEmitter<TagNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private tags: TagNode[] = [];

    constructor(private readonly gitService: GitService) {}

    async refresh(): Promise<void> {
        try {
            const entries = await this.gitService.getTags();
            this.tags = entries.map(t => ({ ...t, contextValue: 'tag' as const }));
        } catch {
            this.tags = [];
        }
        this._onDidChangeTreeData.fire();
    }

    // -------------------------------------------------------------------------
    // TreeDataProvider
    // -------------------------------------------------------------------------

    getTreeItem(element: TagNode): vscode.TreeItem {
        const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
        item.description = `${element.sha.slice(0, 7)}  ${element.date}`;
        item.tooltip = new vscode.MarkdownString(
            `**${element.name}**  ${element.isAnnotated ? '(annotated)' : '(lightweight)'}\n\n` +
            `SHA: \`${element.sha}\`\n\n` +
            `Date: ${element.date}\n\n` +
            (element.subject ? `Message: ${element.subject}` : '')
        );
        item.iconPath = new vscode.ThemeIcon('tag');
        item.contextValue = 'tag';
        item.command = {
            command: 'gitlite.openCommitDetails',
            title: 'Open Commit Details',
            arguments: [element.sha],
        };
        return item;
    }

    getChildren(element?: TagNode): vscode.ProviderResult<TagNode[]> {
        if (element) { return []; }
        return this.tags;
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}
