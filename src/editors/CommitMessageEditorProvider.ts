import * as vscode from 'vscode';

/**
 * CustomTextEditorProvider that intercepts COMMIT_EDITMSG, SQUASH_MSG, and
 * MERGE_MSG files opened by Git during interactive rebase (reword, squash)
 * and replaces the default text editor with a clean message-editing UI.
 */
export class CommitMessageEditorProvider
    implements vscode.CustomTextEditorProvider, vscode.Disposable
{
    static readonly viewType = 'gitviz.commitMessageEditor';

    async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
    ): Promise<void> {
        const originalText = document.getText();
        const lines = originalText.split('\n');
        const messageLines = lines.filter(l => !l.startsWith('#'));
        const commentLines = lines.filter(l => l.startsWith('#'));
        const message = messageLines.join('\n').trim();
        const comments = commentLines.join('\n');

        webviewPanel.webview.options = { enableScripts: true };
        webviewPanel.webview.html = buildHtml(message, comments, document.fileName);

        webviewPanel.webview.onDidReceiveMessage(async (msg: { type: string; content?: string }) => {
            if (msg.type === 'save' && msg.content !== undefined) {
                const newText = msg.content.trimEnd() + '\n'
                    + (comments ? '\n' + comments + '\n' : '');
                const edit = new vscode.WorkspaceEdit();
                edit.replace(
                    document.uri,
                    new vscode.Range(
                        document.positionAt(0),
                        document.positionAt(originalText.length),
                    ),
                    newText,
                );
                await vscode.workspace.applyEdit(edit);
                await document.save();
                webviewPanel.dispose();
            }
        });
    }

    dispose(): void {}
}

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildHtml(message: string, comments: string, fileName: string): string {
    const baseName = fileName.split('/').pop() ?? '';
    const isSquash = baseName === 'SQUASH_MSG';
    const isMerge  = baseName === 'MERGE_MSG';
    const title = isSquash ? 'Squash Commit Message'
                : isMerge  ? 'Merge Commit Message'
                : 'Edit Commit Message';

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; display: flex; flex-direction: column; overflow: hidden; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}
#header {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 12px; flex-shrink: 0;
  border-bottom: 1px solid var(--vscode-editorWidget-border, var(--vscode-focusBorder));
}
#header h2 { font-size: 1em; font-weight: 600; flex: 1; }
.hdr-btn {
  padding: 3px 10px; font: inherit; font-size: 0.85em;
  cursor: pointer; border-radius: 3px; border: 1px solid transparent;
}
.hdr-btn-primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
.hdr-btn-primary:hover { background: var(--vscode-button-hoverBackground); }
#body { flex: 1; overflow-y: auto; display: flex; flex-direction: column; padding: 12px; gap: 10px; }
#message {
  width: 100%;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 3px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 13px);
  padding: 8px;
  resize: none;
  line-height: 1.5;
  overflow: hidden;
}
#message:focus { outline: 1px solid var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }
#hint { font-size: 0.82em; color: var(--vscode-descriptionForeground); }
#comments {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 0.82em;
  color: var(--vscode-descriptionForeground);
  opacity: 0.5;
  white-space: pre-wrap;
  word-break: break-word;
  padding-bottom: 12px;
}
</style>
</head>
<body>
<div id="header">
  <h2>${esc(title)}</h2>
  <button class="hdr-btn hdr-btn-primary" id="btn-save">Save &amp; Continue</button>
</div>
<div id="body">
  <textarea id="message" spellcheck="true" autofocus>${esc(message)}</textarea>
  <p id="hint">Lines starting with # are comments and will be ignored by Git.</p>
  <pre id="comments">${esc(comments)}</pre>
</div>
<script>
(function() {
'use strict';
var vsc = acquireVsCodeApi();
var ta = document.getElementById('message');

function autoResize() {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}
ta.addEventListener('input', autoResize);
autoResize();
ta.focus();
// Place cursor at end
ta.setSelectionRange(ta.value.length, ta.value.length);

function save() {
  vsc.postMessage({ type: 'save', content: ta.value });
}

document.getElementById('btn-save').addEventListener('click', save);
document.addEventListener('keydown', function(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    save();
  }
});
})();
</script>
</body>
</html>`;
}
