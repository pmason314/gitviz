import * as vscode from 'vscode';
import { GitService } from '../git/GitService';
import { BranchInfo } from '../git/types';

// ---------------------------------------------------------------------------
// Node types
// ---------------------------------------------------------------------------

/** Root section nodes: "Local" and "Remote" */
interface SectionNode {
    kind: 'section';
    label: string;
}

interface LocalBranchNode {
    kind: 'localBranch';
    branch: BranchInfo;
    upstreamGone: boolean;
}

interface RemoteBranchNode {
    kind: 'remoteBranch';
    fullName: string;   // "origin/main"
    shortName: string;  // "main"
    sha: string;
    subject: string;
}

type BranchNode = SectionNode | LocalBranchNode | RemoteBranchNode;

export class BranchesProvider
    implements vscode.TreeDataProvider<BranchNode>, vscode.Disposable {

    private readonly _onDidChangeTreeData = new vscode.EventEmitter<BranchNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private localBranches: BranchInfo[] = [];
    private remoteBranches: RemoteBranchNode[] = [];
    private _showUntracked = false;

    constructor(private readonly gitService: GitService) {}

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    setShowUntracked(val: boolean): void {
        this._showUntracked = val;
        this._onDidChangeTreeData.fire();
    }

    async refresh(): Promise<void> {
        try {
            this.localBranches = await this.gitService.getBranches();
        } catch (err) {
            console.error('[GitLite] BranchesProvider: failed to load local branches', err);
            this.localBranches = [];
        }

        // Gather remote-tracking branches from remotes
        try {
            const remotes = await this.gitService.getRemotes();
            this.remoteBranches = remotes.flatMap(r =>
                r.branches.map(b => ({
                    kind: 'remoteBranch' as const,
                    fullName: b.fullName,
                    shortName: `${r.name}/${b.shortName}`,
                    sha: b.sha,
                    subject: b.subject,
                }))
            );
        } catch (err) {
            console.error('[GitLite] BranchesProvider: failed to load remote branches', err);
            this.remoteBranches = [];
        }

        this._onDidChangeTreeData.fire();
    }

    // -------------------------------------------------------------------------
    // TreeDataProvider
    // -------------------------------------------------------------------------

    getTreeItem(element: BranchNode): vscode.TreeItem {
        if (element.kind === 'section') {
            const item = new vscode.TreeItem(
                element.label,
                vscode.TreeItemCollapsibleState.Expanded,
            );
            item.contextValue = element.label === 'Local' ? 'branchSectionLocal' : 'branchSection';
            return item;
        }

        if (element.kind === 'localBranch') {
            const b = element.branch;
            const badges: string[] = [];
            if (b.ahead  > 0) { badges.push(`↑${b.ahead}`); }
            if (b.behind > 0) { badges.push(`↓${b.behind}`); }
            const badgeStr = badges.join(' ');

            const item = new vscode.TreeItem(b.name, vscode.TreeItemCollapsibleState.None);
            item.description = badgeStr ? `${badgeStr}  ${b.sha.slice(0, 7)}` : b.sha.slice(0, 7);
            item.tooltip = new vscode.MarkdownString(
                `**${b.name}**\n\n` +
                (b.upstream ? `Tracking: \`${b.upstream}\`\n\n` : '') +
                (element.upstreamGone ? `⚠️ Remote tracking branch no longer exists — likely merged\n\n` : '') +
                (b.ahead  ? `↑ ${b.ahead} ahead of upstream\n\n` : '') +
                (b.behind ? `↓ ${b.behind} behind upstream\n\n` : '') +
                `Last commit: ${b.subject}`
            );
            item.iconPath = new vscode.ThemeIcon(
                element.upstreamGone ? 'git-merge' : (b.isCurrent ? 'star-full' : 'git-branch'),
                element.upstreamGone
                    ? new vscode.ThemeColor('gitDecoration.ignoredResourceForeground')
                    : b.isCurrent ? new vscode.ThemeColor('gitDecoration.addedResourceForeground') : undefined,
            );
            item.contextValue = b.isCurrent ? 'currentBranch' : 'localBranch';
            return item;
        }

        // remoteBranch
        const item = new vscode.TreeItem(element.shortName, vscode.TreeItemCollapsibleState.None);
        item.description = element.sha.slice(0, 7);
        item.tooltip = element.subject;
        item.iconPath = new vscode.ThemeIcon('cloud');
        item.contextValue = 'remoteBranch';
        item.command = {
            command: 'gitlite.openCommitDetails',
            title: 'Open Commit Details',
            arguments: [element.sha],
        };
        return item;
    }

    getChildren(element?: BranchNode): vscode.ProviderResult<BranchNode[]> {
        if (!element) {
            const sections: BranchNode[] = [
                { kind: 'section', label: 'Local' },
                { kind: 'section', label: 'Remote' },
            ];
            return sections;
        }

        if (element.kind === 'section') {
            if (element.label === 'Local') {
                const branches = this._showUntracked
                    ? this.localBranches.filter(b => !b.upstream)
                    : this.localBranches;
                return branches.map(b => ({
                    kind: 'localBranch' as const,
                    branch: b,
                    upstreamGone: b.upstreamGone,
                }));
            }
            return this._showUntracked ? [] : this.remoteBranches;
        }

        return [];
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}
