import * as path from 'path';
import * as vscode from 'vscode';
import { GitService } from '../git/GitService';
import { WorktreeInfo } from '../git/types';

type WorktreeNode = WorktreeInfo & { contextValue: 'worktree' | 'worktreeCurrent' };

export class WorktreesProvider
    implements vscode.TreeDataProvider<WorktreeNode>, vscode.Disposable {

    private readonly _onDidChangeTreeData = new vscode.EventEmitter<WorktreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private worktrees: WorktreeNode[] = [];

    constructor(private readonly gitService: GitService) {}

    async refresh(): Promise<void> {
        try {
            const repoRoot = this.gitService.getRepoRoot();
            const entries = await this.gitService.getWorktrees();
            this.worktrees = entries.map(w => ({
                ...w,
                contextValue: (w.path === repoRoot ? 'worktreeCurrent' : 'worktree') as 'worktree' | 'worktreeCurrent',
            }));
        } catch (err) {
            console.error('[GitViz] WorktreesProvider: failed to load worktrees', err);
            this.worktrees = [];
        }
        this._onDidChangeTreeData.fire();
    }

    // -------------------------------------------------------------------------
    // TreeDataProvider
    // -------------------------------------------------------------------------

    getTreeItem(element: WorktreeNode): vscode.TreeItem {
        const repoRoot = this.gitService.getRepoRoot();
        const isCurrent = element.path === repoRoot;

        // Label: short branch name, or special label for detached/bare
        let label: string;
        if (element.isBare) {
            label = '(bare)';
        } else if (!element.branch) {
            label = `(detached: ${element.head.slice(0, 7)})`;
        } else {
            label = element.branch.replace(/^refs\/heads\//, '');
        }

        // Description: folder name + optional status counts + (current) marker
        const folderName = path.basename(element.path);
        const statusParts: string[] = [];
        if (element.staged > 0)   { statusParts.push(`+${element.staged}`); }
        if (element.unstaged > 0) { statusParts.push(`~${element.unstaged}`); }
        const statusStr = statusParts.length > 0 ? `${statusParts.join(' ')}  ` : '';
        const currentStr = isCurrent ? '  (current)' : '';
        const description = `${statusStr}${folderName}${currentStr}`;

        // Tooltip
        const cleanDirty = (element.staged > 0 || element.unstaged > 0)
            ? `+${element.staged} staged  ~${element.unstaged} unstaged`
            : 'clean';
        const tooltip = new vscode.MarkdownString(
            `**${label}**\n\n` +
            `${element.path}\n\n` +
            (element.head ? `${element.head.slice(0, 7)}  ·  ${cleanDirty}` : cleanDirty)
        );

        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.description = description;
        item.tooltip = tooltip;
        item.iconPath = new vscode.ThemeIcon(isCurrent ? 'folder-active' : 'files');
        item.contextValue = element.contextValue;

        if (!element.isBare && !isCurrent) {
            item.command = {
                command: 'gitviz.worktree.open',
                title: 'Open Worktree in New Window',
                arguments: [element],
            };
        }

        return item;
    }

    getChildren(element?: WorktreeNode): vscode.ProviderResult<WorktreeNode[]> {
        if (element) { return []; }
        return this.worktrees;
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}
