import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GitService } from '../git/GitService';
import { CommitEntry, TagInfo } from '../git/types';

export class CommitsView implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'gitviz.commits';

    private _view?: vscode.WebviewView;
    private cachedCommits: CommitEntry[] = [];
    private cachedAuthors: string[] = [];
    private cachedTags: TagInfo[] = [];

    constructor(private readonly gitService: GitService, private readonly extensionUri: vscode.Uri) {}

    async refresh(): Promise<void> {
        try {
            this.cachedCommits = await this.gitService.getCommitsOnBranch(undefined, 200);
        } catch (err) {
            console.error('[GitViz] CommitsView: failed to load commits', err);
            this.cachedCommits = [];
        }
        try {
            const contributors = await this.gitService.getContributors();
            this.cachedAuthors = contributors.map(c => c.name).filter(Boolean);
        } catch (err) {
            console.error('[GitViz] CommitsView: failed to load contributors', err);
            this.cachedAuthors = [];
        }
        try {
            this.cachedTags = await this.gitService.getTags();
        } catch (err) {
            console.error('[GitViz] CommitsView: failed to load tags', err);
            this.cachedTags = [];
        }
        this._sendUpdate();
        this._sendAuthors();
        this._sendTags();
    }

    setFilter(value: string): void {
        this._view?.webview.postMessage({ type: 'setFilter', value });
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = fs.readFileSync(path.join(this.extensionUri.fsPath, 'resources', 'commitsView.html'), 'utf8');

        webviewView.webview.onDidReceiveMessage(async (msg: { type: string; sha?: string; name?: string }) => {
            switch (msg.type) {
                case 'openCommitDetails':
                    if (msg.sha) {
                        await vscode.commands.executeCommand('gitviz.openCommitDetails', msg.sha);
                    }
                    break;
                case 'openGraph':
                    if (msg.sha) {
                        await vscode.commands.executeCommand('gitviz.openCommitGraph', msg.sha);
                    }
                    break;
                case 'copySha':
                    if (msg.sha) {
                        await vscode.env.clipboard.writeText(msg.sha);
                        vscode.window.showInformationMessage(`GitViz: Copied ${msg.sha.slice(0, 7)} to clipboard.`);
                    }
                    break;
                case 'requestCreateTag': {
                    if (!msg.sha) { break; }
                    const tagName = await vscode.window.showInputBox({
                        title: `Create Tag at ${msg.sha.slice(0, 7)}`,
                        placeHolder: 'v1.0.0',
                        validateInput: v => v.trim() ? undefined : 'Tag name cannot be empty',
                    });
                    if (!tagName) { break; }
                    const annotation = await vscode.window.showInputBox({
                        title: 'Tag Annotation (optional)',
                        prompt: 'Leave empty to create a lightweight tag',
                        placeHolder: 'e.g. Release v1.0.0',
                    });
                    if (annotation === undefined) { break; } // user pressed Escape
                    try {
                        await this.gitService.createTag(tagName.trim(), msg.sha, annotation.trim() || undefined);
                        await this.refresh();
                        await this.promptAndPushTag(tagName.trim());
                    } catch (err) {
                        vscode.window.showErrorMessage(`GitViz: ${(err as Error).message}`);
                    }
                    break;
                }
                case 'requestDeleteTag': {
                    if (!msg.name) { break; }
                    const confirmed = await vscode.window.showWarningMessage(
                        `Delete tag \"${msg.name}\"?  This cannot be undone.`, { modal: true }, 'Delete'
                    );
                    if (confirmed !== 'Delete') { break; }
                    try {
                        await this.gitService.deleteTag(msg.name);
                        await this.refresh();
                        vscode.window.showInformationMessage(`GitViz: Tag \"${msg.name}\" deleted.`);
                    } catch (err) {
                        vscode.window.showErrorMessage(`GitViz: ${(err as Error).message}`);
                    }
                    break;
                }
            }
        });

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this._sendUpdate();
                this._sendAuthors();
                this._sendTags();
            }
        });

        void this.refresh();
    }

    private _sendUpdate(): void {
        if (!this._view) { return; }
        const commits = this.cachedCommits.map(c => ({
            sha: c.sha,
            message: c.message,
            author: c.author,
            relativeDate: c.relativeDate,
            shortAuthor: c.author ? c.author.split(/[\s@\-_]/)[0] : '',
            shortDate: c.relativeDate
                ? c.relativeDate
                    .replace(/^an? /, '1 ')
                    .replace(/(\d+) seconds? ago/, '$1s ago')
                    .replace(/(\d+) minutes? ago/, '$1m ago')
                    .replace(/(\d+) hours? ago/, '$1h ago')
                    .replace(/(\d+) days? ago/, '$1d ago')
                    .replace(/(\d+) weeks? ago/, '$1w ago')
                    .replace(/(\d+) months? ago/, '$1mo ago')
                    .replace(/(\d+) years? ago/, '$1y ago')
                : '',
        }));
        this._view.webview.postMessage({ type: 'update', commits });
    }

    private _sendAuthors(): void {
        if (!this._view) { return; }
        this._view.webview.postMessage({ type: 'setAuthors', names: this.cachedAuthors });
    }

    private _sendTags(): void {
        if (!this._view) { return; }
        this._view.webview.postMessage({
            type: 'setTags',
            tags: this.cachedTags.map(t => ({ sha: t.sha, name: t.name })),
        });
        // Fetch remote status in background — don't block, silently fail if offline
        this.gitService.getRemoteTagNames()
            .then(names => this._sendTagStatus(names))
            .catch(() => {/* offline or no remotes */});
    }

    private _sendTagStatus(remoteNames: Set<string>): void {
        if (!this._view) { return; }
        this._view.webview.postMessage({ type: 'setTagStatus', remoteNames: [...remoteNames] });
    }

    showTagsOnly(): void {
        this._view?.webview.postMessage({ type: 'showTagsOnly' });
    }

    showAllCommits(): void {
        this._view?.webview.postMessage({ type: 'showAllCommits' });
    }

    async promptAndPushTag(tagName: string): Promise<void> {
        let remotes: import('../git/types').RemoteInfo[];
        try {
            remotes = await this.gitService.getRemotes();
        } catch {
            vscode.window.showInformationMessage(`GitViz: Tag "${tagName}" created.`);
            return;
        }
        if (!remotes.length) {
            vscode.window.showInformationMessage(`GitViz: Tag "${tagName}" created.`);
            return;
        }
        let remote: string;
        if (remotes.length === 1) {
            const answer = await vscode.window.showInformationMessage(
                `Tag "${tagName}" created. Push to ${remotes[0].name}?`, 'Push', 'Skip'
            );
            if (answer !== 'Push') { return; }
            remote = remotes[0].name;
        } else {
            const picked = await vscode.window.showQuickPick(
                remotes.map(r => r.name),
                { title: `Push tag "${tagName}" to remote?`, placeHolder: 'Select remote, or press Escape to skip' }
            );
            if (!picked) { return; }
            remote = picked;
        }
        try {
            await this.gitService.pushTag(tagName, remote);
            vscode.window.showInformationMessage(`GitViz: Tag "${tagName}" pushed to ${remote}.`);
        } catch (err) {
            vscode.window.showErrorMessage(`GitViz: ${(err as Error).message}`);
        }
    }

    dispose(): void { /* nothing to dispose */ }

}
