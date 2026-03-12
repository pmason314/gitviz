import * as path from 'path';
import * as vscode from 'vscode';
import { GitService } from '../git/GitService';
import { CommitFileEntry } from '../git/types';
import { makeRevisionUri } from '../editors/RevisionContentProvider';

/**
 * Editor-tab webview panel that shows the list of files changed between two
 * git refs (branches, SHAs, or working directory). Each file is clickable to
 * open a vscode.diff of that file between the two refs.
 */
export class ComparePanel implements vscode.Disposable {
    private static readonly VIEW_TYPE = 'gitlite.comparePanel';

    private panel: vscode.WebviewPanel | undefined;
    private currentRef1 = '';
    private currentRef2 = '';
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly gitService: GitService) {}

    async show(ref1: string, ref2: string): Promise<void> {
        this.currentRef1 = ref1;
        this.currentRef2 = ref2;

        const label1 = ref1 || 'Working Dir';
        const label2 = ref2 || 'Working Dir';
        const title = `${label1} ↔ ${label2}`;

        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel(
                ComparePanel.VIEW_TYPE,
                title,
                vscode.ViewColumn.Active,
                { enableScripts: true, retainContextWhenHidden: true },
            );
            this.panel.onDidDispose(() => { this.panel = undefined; }, null, this.disposables);
            this.panel.webview.onDidReceiveMessage(
                (msg: { command: string; path?: string }) =>
                    this.handleMessage(msg).catch((err: Error) => {
                        vscode.window.showErrorMessage(`GitLite: ${err.message}`);
                    }),
                null,
                this.disposables,
            );
        } else {
            this.panel.title = title;
            this.panel.reveal(vscode.ViewColumn.Active);
        }

        // Show loading state immediately, then populate
        this.panel.webview.html = buildLoadingHtml(label1, label2);
        const files = await this.gitService.getDiffFiles(ref1, ref2);
        this.panel.webview.html = buildHtml(label1, label2, files);
    }

    private async handleMessage(msg: { command: string; path?: string }): Promise<void> {
        if (msg.command !== 'openDiff' || !msg.path) { return; }
        const repoRoot = this.gitService.getRepoRoot();
        const absPath = path.join(repoRoot, msg.path);
        const leftUri = this.currentRef1
            ? makeRevisionUri(repoRoot, this.currentRef1, absPath)
            : vscode.Uri.file(absPath);
        const rightUri = this.currentRef2
            ? makeRevisionUri(repoRoot, this.currentRef2, absPath)
            : vscode.Uri.file(absPath);
        const label1 = this.currentRef1 || 'WD';
        const label2 = this.currentRef2 || 'WD';
        const title = `${path.basename(msg.path)} (${label1} ↔ ${label2})`;
        const viewColumn = this.panel?.viewColumn ?? vscode.ViewColumn.Active;
        await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, { viewColumn });
    }

    dispose(): void {
        this.panel?.dispose();
        for (const d of this.disposables) { d.dispose(); }
    }
}

// ---------------------------------------------------------------------------
// HTML builders
// ---------------------------------------------------------------------------

const SHARED_CSS = /* css */`
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 20px;
      line-height: 1.6;
      margin: 0;
    }
    .heading { font-size: 1.1em; font-weight: 600; margin: 0 0 4px; }
    .refs { font-family: monospace; color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-bottom: 14px; }
    .ref { background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.1)); padding: 1px 5px; border-radius: 3px; }
    hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 16px 0; }
    .section-heading { font-weight: 600; margin-bottom: 8px; }
    .summary { margin-bottom: 10px; font-size: 0.9em; color: var(--vscode-descriptionForeground); }
    .file {
      display: flex; align-items: center; gap: 8px;
      padding: 3px 6px; border-radius: 3px; cursor: pointer;
      font-family: monospace; font-size: 0.88em;
    }
    .file:hover { background: var(--vscode-list-hoverBackground); }
    .file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .stats { white-space: nowrap; font-size: 0.9em; }
    .status-badge { display: inline-block; width: 14px; text-align: center; font-weight: 700; font-size: 0.8em; flex-shrink: 0; }
    .status-A { color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950); }
    .status-M { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e3b341); }
    .status-D { color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149); }
    .status-R { color: var(--vscode-gitDecoration-renamedResourceForeground, #73c991); }
    .status-C { color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950); }
    .empty { color: var(--vscode-descriptionForeground); font-style: italic; }
`;

function buildLoadingHtml(label1: string, label2: string): string {
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <style>${SHARED_CSS}</style>
</head>
<body>
  <div class="heading">Comparing refs</div>
  <div class="refs"><span class="ref">${escHtml(label1)}</span> ↔ <span class="ref">${escHtml(label2)}</span></div>
  <div class="empty">Loading…</div>
</body>
</html>`;
}

function buildHtml(label1: string, label2: string, files: CommitFileEntry[]): string {
    const filesHtml = files.map((f) => {
        const ins = f.insertions === -1 ? '—' : `+${f.insertions}`;
        const del = f.deletions === -1 ? '' : `-${f.deletions}`;
        const insColor = f.insertions > 0 ? '#3fb950' : 'var(--vscode-descriptionForeground)';
        const delColor = f.deletions > 0 ? '#f85149' : 'var(--vscode-descriptionForeground)';
        const badge = (f.status && f.status !== '?') ? `<span class="status-badge status-${f.status}">${f.status}</span>` : '<span class="status-badge"></span>';

        return `<div class="file" data-path="${escHtml(f.path)}" onclick="openDiff(this.dataset.path)">
  ${badge}<span class="file-name">${escHtml(f.path)}</span>
  <span class="stats">
    <span style="color:${insColor}">${ins}</span>${del ? ` <span style="color:${delColor}">${del}</span>` : ''}
  </span>
</div>`;
    }).join('\n');

    const totalIns = files.reduce((s, f) => s + (f.insertions > 0 ? f.insertions : 0), 0);
    const totalDel = files.reduce((s, f) => s + (f.deletions > 0 ? f.deletions : 0), 0);
    const summary = files.length > 0
        ? `<span style="color:#3fb950">+${totalIns}</span> <span style="color:#f85149">-${totalDel}</span>`
        : '';

    const body = files.length === 0
        ? '<div class="empty">No differences found.</div>'
        : `<div class="section-heading">${files.length} file${files.length !== 1 ? 's' : ''} changed</div>
  <div class="summary">${summary}</div>
  <div class="files">${filesHtml}</div>`;

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>Compare</title>
  <style>${SHARED_CSS}</style>
</head>
<body>
  <div class="heading">Comparing refs</div>
  <div class="refs"><span class="ref">${escHtml(label1)}</span> ↔ <span class="ref">${escHtml(label2)}</span></div>
  <hr>
  ${body}
  <script>
    const vscode = acquireVsCodeApi();
    function openDiff(filePath) {
      vscode.postMessage({ command: 'openDiff', path: filePath });
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
