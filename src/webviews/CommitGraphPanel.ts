import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GitService } from '../git/GitService';

/**
 * Singleton webview panel that renders a canvas-based commit graph (DAG).
 * Opened as an editor tab; shows all local branches + their upstream remotes.
 */
export class CommitGraphPanel implements vscode.Disposable {
    private static readonly VIEW_TYPE = 'gitlite.commitGraph';
    private static instance: CommitGraphPanel | undefined;

    private panel: vscode.WebviewPanel | undefined;
    private readonly disposables: vscode.Disposable[] = [];

    private constructor(private readonly gitService: GitService, private readonly extensionUri: vscode.Uri) {}

    static getInstance(gitService: GitService, extensionUri: vscode.Uri): CommitGraphPanel {
        if (!CommitGraphPanel.instance) {
            CommitGraphPanel.instance = new CommitGraphPanel(gitService, extensionUri);
        }
        return CommitGraphPanel.instance;
    }

    /**
     * Open (or reveal) the graph panel, optionally scrolling to a specific commit.
     */
    async open(scrollToSha?: string): Promise<void> {
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel(
                CommitGraphPanel.VIEW_TYPE,
                'Commit Graph',
                vscode.ViewColumn.Active,
                { enableScripts: true, retainContextWhenHidden: true }
            );
            this.panel.onDidDispose(() => {
                this.panel = undefined;
            }, null, this.disposables);
            this.panel.webview.onDidReceiveMessage(
                (msg: Record<string, unknown>) => this.handleMessage(msg),
                null,
                this.disposables
            );
            this.panel.webview.html = fs.readFileSync(path.join(this.extensionUri.fsPath, 'resources', 'commitGraph.html'), 'utf8');
        } else {
            this.panel.reveal(vscode.ViewColumn.Active);
        }

        await this.loadAndSend(scrollToSha);
    }

    private async loadAndSend(scrollToSha?: string, offset = 0): Promise<void> {
        const [commits, refs] = await Promise.all([
            this.gitService.getCommitGraph(500, offset),
            offset === 0 ? this.gitService.getGraphRefs() : Promise.resolve(null),
        ]);
        if (!this.panel) { return; }

        this.panel.webview.postMessage({
            type: offset === 0 ? 'init' : 'append',
            commits: commits.map(c => ({
                sha: c.sha,
                parents: c.parents,
                author: c.author,
                relativeDate: c.relativeDate,
                message: c.message,
            })),
            refs: refs ?? undefined,
            scrollTo: offset === 0 ? scrollToSha : undefined,
            hasMore: commits.length === 500,
            nextOffset: offset + commits.length,
        });
    }

    private async handleMessage(msg: Record<string, unknown>): Promise<void> {
        switch (msg.type) {
            case 'loadMore':
                await this.loadAndSend(undefined, (msg.offset as number) ?? 0);
                break;

            case 'openDetails':
                if (typeof msg.sha === 'string') {
                    await vscode.commands.executeCommand('gitlite.openCommitDetails', msg.sha);
                }
                break;

            case 'copySha':
                if (typeof msg.sha === 'string') {
                    await vscode.env.clipboard.writeText(msg.sha);
                    vscode.window.showInformationMessage(`GitLite: Copied ${msg.sha.slice(0, 7)} to clipboard.`);
                }
                break;

            case 'checkout': {
                const ref = msg.ref as string;
                if (!ref) { break; }
                try {
                    await this.gitService.checkoutRef(ref);
                    await this.open();
                    await vscode.commands.executeCommand('gitlite.refreshAll');
                } catch (err) {
                    vscode.window.showErrorMessage(`GitLite: Checkout failed — ${(err as Error).message}`);
                }
                break;
            }

            case 'createBranch': {
                const sha = msg.sha as string;
                if (!sha) { break; }
                const name = await vscode.window.showInputBox({
                    prompt: `Create new branch at ${sha.slice(0, 7)}`,
                    placeHolder: 'branch-name',
                    validateInput: v => /^[\w./-]+$/.test(v.trim()) ? null : 'Invalid branch name',
                });
                if (!name?.trim()) { break; }
                try {
                    await this.gitService.createBranchFrom(sha, name.trim());
                    await this.open(sha);
                    await vscode.commands.executeCommand('gitlite.refreshAll');
                } catch (err) {
                    vscode.window.showErrorMessage(`GitLite: Create branch failed — ${(err as Error).message}`);
                }
                break;
            }

            case 'cherryPick': {
                const sha = msg.sha as string;
                if (!sha) { break; }
                const confirm = await vscode.window.showWarningMessage(
                    `Cherry-pick ${sha.slice(0, 7)} onto current branch?`,
                    { modal: true }, 'Cherry-pick'
                );
                if (confirm !== 'Cherry-pick') { break; }
                try {
                    await this.gitService.cherryPick(sha);
                    await this.open();
                    await vscode.commands.executeCommand('gitlite.refreshAll');
                } catch (err) {
                    vscode.window.showErrorMessage(`GitLite: Cherry-pick failed — ${(err as Error).message}`);
                }
                break;
            }

            case 'reset': {
                const sha = msg.sha as string;
                if (!sha) { break; }
                const mode = await vscode.window.showQuickPick(
                    [
                        { label: '$(history) Soft', description: 'Keep staged and working changes', value: 'soft' as const },
                        { label: '$(discard) Mixed', description: 'Keep working changes, unstage index', value: 'mixed' as const },
                        { label: '$(trash) Hard', description: 'Discard all changes (cannot be undone)', value: 'hard' as const },
                    ],
                    { title: `Reset to ${sha.slice(0, 7)}`, placeHolder: 'Choose reset mode' }
                );
                if (!mode) { break; }
                if (mode.value === 'hard') {
                    const confirm = await vscode.window.showWarningMessage(
                        `Hard reset to ${sha.slice(0, 7)}? All uncommitted changes will be lost.`,
                        { modal: true }, 'Hard Reset'
                    );
                    if (confirm !== 'Hard Reset') { break; }
                }
                try {
                    await this.gitService.resetToCommit(sha, mode.value);
                    await this.open(sha);
                    await vscode.commands.executeCommand('gitlite.refreshAll');
                } catch (err) {
                    vscode.window.showErrorMessage(`GitLite: Reset failed — ${(err as Error).message}`);
                }
                break;
            }
        }
    }

    dispose(): void {
        CommitGraphPanel.instance = undefined;
        this.panel?.dispose();
        for (const d of this.disposables) { d.dispose(); }
    }
}

