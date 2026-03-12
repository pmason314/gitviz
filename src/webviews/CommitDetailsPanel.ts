import * as path from 'path';
import * as vscode from 'vscode';
import { GitService } from '../git/GitService';
import { CommitInfo, CommitFileEntry } from '../git/types';
import { makeRevisionUri } from '../editors/RevisionContentProvider';

/**
 * Singleton webview panel that displays rich commit details:
 * metadata, body, changed files with +/- counts, and per-file diff links.
 */
export class CommitDetailsPanel implements vscode.Disposable {
    private static readonly VIEW_TYPE = 'gitlite.commitDetails';

    private panel: vscode.WebviewPanel | undefined;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly gitService: GitService) {}

    async show(sha: string, highlightAbsPath?: string): Promise<void> {
        const isStash = /^stash@\{/.test(sha);
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel(
                CommitDetailsPanel.VIEW_TYPE,
                isStash ? 'Stash' : `Commit ${sha.slice(0, 7)}`,
                vscode.ViewColumn.Active,
                { enableScripts: true, retainContextWhenHidden: true }
            );
            this.panel.onDidDispose(() => { this.panel = undefined; }, null, this.disposables);
            this.panel.webview.onDidReceiveMessage(
                (msg: { command: string; path?: string; sha?: string }) =>
                    this.handleMessage(msg).catch((err: Error) => {
                        vscode.window.showErrorMessage(`GitLite: ${err.message}`);
                    }),
                null,
                this.disposables
            );
        } else {
            this.panel.title = isStash ? 'Stash' : `Commit ${sha.slice(0, 7)}`;
            this.panel.reveal(vscode.ViewColumn.Active);
        }

        // Fetch metadata and file list concurrently
        const [commit, files] = await Promise.all([
            this.gitService.getCommit(sha),
            isStash ? this.gitService.getStashFiles(sha) : this.gitService.getCommitFiles(sha),
        ]);

        if (isStash) {
            this.panel.title = `Stash: ${commit.message.slice(0, 50)}`;
        }

        // Convert abs path to repo-relative for highlighting
        const repoRoot = this.gitService.getRepoRoot();
        const highlightRelPath = highlightAbsPath
            ? path.relative(repoRoot, highlightAbsPath).replace(/\\/g, '/')
            : undefined;

        this.panel.webview.html = buildHtml(commit, files, highlightRelPath);
    }

    private async handleMessage(msg: { command: string; path?: string; sha?: string }): Promise<void> {
        if (msg.command === 'openDiff' && msg.path && msg.sha) {
            const repoRoot = this.gitService.getRepoRoot();
            const absPath = path.join(repoRoot, msg.path);
            const prevUri = makeRevisionUri(repoRoot, `${msg.sha}~1`, absPath);
            const currUri = makeRevisionUri(repoRoot, msg.sha, absPath);
            const title = `${path.basename(msg.path)} (${msg.sha.slice(0, 7)}^ ↔ ${msg.sha.slice(0, 7)})`;
            // Open diff in the same column as the commit details panel
            const viewColumn = this.panel?.viewColumn ?? vscode.ViewColumn.Active;
            await vscode.commands.executeCommand('vscode.diff', prevUri, currUri, title, { viewColumn });
        } else if (msg.command === 'revealCommit' && msg.sha) {
            await vscode.commands.executeCommand('gitlite.revealCommit', msg.sha);
        }
    }

    dispose(): void {
        this.panel?.dispose();
        for (const d of this.disposables) { d.dispose(); }
    }
}

// ---------------------------------------------------------------------------
// HTML builder
// ---------------------------------------------------------------------------

function buildHtml(commit: CommitInfo, files: CommitFileEntry[], highlightRelPath?: string): string {
    const short = escHtml(commit.sha.slice(0, 7));
    const fullSha = escHtml(commit.sha);
    const dateStr = commit.date.toLocaleString(undefined, {
        year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });

    const filesHtml = files.map((f) => {
        const ins = f.insertions === -1 ? '—' : `+${f.insertions}`;
        const del = f.deletions === -1 ? '' : `-${f.deletions}`;
        const insColor = f.insertions > 0 ? '#3fb950' : 'var(--vscode-descriptionForeground)';
        const delColor = f.deletions > 0 ? '#f85149' : 'var(--vscode-descriptionForeground)';
        const isHighlighted = highlightRelPath && f.path === highlightRelPath;
        const badge = (f.status && f.status !== '?') ? `<span class="status-badge status-${f.status}">${f.status}</span>` : '<span class="status-badge"></span>';

        return `<div class="file${isHighlighted ? ' file--active' : ''}" data-path="${escHtml(f.path)}" onclick="openDiff(this.dataset.path)">
  ${badge}<span class="file-name">${escHtml(f.path)}</span>
  <span class="stats">
    <span style="color:${insColor}">${ins}</span>${del ? ` <span style="color:${delColor}">${del}</span>` : ''}
  </span>
</div>`;
    }).join('\n');

    const totalIns = files.reduce((s, f) => s + (f.insertions > 0 ? f.insertions : 0), 0);
    const totalDel = files.reduce((s, f) => s + (f.deletions > 0 ? f.deletions : 0), 0);
    const summary = files.length === 0 ? '' :
        `<span style="color:#3fb950">+${totalIns}</span> <span style="color:#f85149">-${totalDel}</span>`;

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>Commit ${short}</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 20px;
      line-height: 1.6;
      margin: 0;
    }
    .message { font-size: 1.1em; font-weight: 600; margin: 0 0 4px; }
    .sha { font-family: monospace; color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-bottom: 10px; cursor: pointer; }
    .sha:hover { text-decoration: underline; }
    .body { white-space: pre-wrap; color: var(--vscode-descriptionForeground); margin: 0 0 10px; font-size: 0.9em; }
    .meta { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin: 2px 0; }
    hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 16px 0; }
    .section-heading { font-weight: 600; margin-bottom: 8px; }
    .summary { margin-bottom: 10px; font-size: 0.9em; color: var(--vscode-descriptionForeground); }
    .file {
      display: flex; align-items: center; gap: 8px;
      padding: 3px 6px; border-radius: 3px; cursor: pointer;
      font-family: monospace; font-size: 0.88em;
    }
    .file:hover { background: var(--vscode-list-hoverBackground); }
    .file--active { background: var(--vscode-editor-lineHighlightBackground, rgba(255,255,255,0.06)); border-left: 2px solid var(--vscode-focusBorder); padding-left: 4px; }
    .file--active:hover { background: var(--vscode-list-hoverBackground); }
    .file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .stats { white-space: nowrap; font-size: 0.9em; }
    .status-badge { display: inline-block; width: 14px; text-align: center; font-weight: 700; font-size: 0.8em; flex-shrink: 0; }
    .status-A { color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950); }
    .status-M { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e3b341); }
    .status-D { color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149); }
    .status-R { color: var(--vscode-gitDecoration-renamedResourceForeground, #73c991); }
    .status-C { color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950); }
  </style>
</head>
<body>
  <div class="message">${escHtml(commit.message)}</div>
  <div class="sha" onclick="revealCommit()" title="Click to reveal in Commits view">${fullSha}</div>
  ${commit.body ? `<pre class="body">${escHtml(commit.body)}</pre>` : ''}
  <div class="meta">👤 ${escHtml(commit.author)} &lt;${escHtml(commit.authorEmail)}&gt;</div>
  <div class="meta">📅 ${dateStr}</div>
  <hr>
  <div class="section-heading">${files.length} file${files.length !== 1 ? 's' : ''} changed</div>
  <div class="summary">${summary}</div>
  <div class="files">${filesHtml}</div>
  <script>
    const vscode = acquireVsCodeApi();
    const commitSha = ${JSON.stringify(commit.sha)};
    function openDiff(filePath) {
      vscode.postMessage({ command: 'openDiff', path: filePath, sha: commitSha });
    }
    function revealCommit() {
      vscode.postMessage({ command: 'revealCommit', sha: commitSha });
    }
  </script>
</body>
</html>`;
}

function escHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
