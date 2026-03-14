import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from '../git/GitService';
import { RefItem } from '../git/types';

interface RefQuickPickItem extends vscode.QuickPickItem {
    value: string;
}

/**
 * Sidebar webview that presents two ref input fields and a Compare button.
 * Each field has a $(git-branch) button that opens a QuickPick populated from
 * local branches, tags, HEAD, working directory, and recent commits.
 * Empty string = working directory.
 */
export class CompareView implements vscode.WebviewViewProvider, vscode.Disposable {
    static readonly viewType = 'gitviz.searchCompare';

    private _view?: vscode.WebviewView;

    constructor(
        private readonly gitService: GitService,
        private readonly extensionUri: vscode.Uri,
    ) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this._view = webviewView;

        const codiconsUri = webviewView.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'),
        );

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist')],
        };
        webviewView.webview.html = buildHtml(codiconsUri.toString(), webviewView.webview.cspSource);

        webviewView.webview.onDidReceiveMessage(
            async (msg: { type: string; slot?: number; ref1?: string; ref2?: string }) => {
                if (msg.type === 'compare') {
                    void vscode.commands.executeCommand(
                        'gitviz.compare.run',
                        msg.ref1 ?? '',
                        msg.ref2 ?? '',
                    );
                } else if (msg.type === 'pickRef') {
                    const refs = await this.gitService.getRefs() as RefQuickPickItem[];
                    const picked = await vscode.window.showQuickPick<RefQuickPickItem>(refs, {
                        title: msg.slot === 1 ? 'Select Base Ref' : 'Select Compare Ref',
                        matchOnDescription: true,
                        matchOnDetail: true,
                        placeHolder: 'Type to filter by branch, tag, or SHA\u2026',
                    });
                    if (picked !== undefined) {
                        const displayValue = picked.value === '' ? 'Working Directory' : picked.value;
                        void webviewView.webview.postMessage({ type: 'setRef', slot: msg.slot, value: displayValue });
                    }
                }
            },
        );
    }

    dispose(): void { /* nothing to clean up */ }
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function buildHtml(codiconsUri: string, cspSource: string): string {
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${cspSource}; style-src ${cspSource} 'unsafe-inline'; script-src 'unsafe-inline';">
  <link rel="stylesheet" href="${codiconsUri}">
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: transparent;
      padding: 5px 8px 6px;
      margin: 0;
    }
    .field { margin-bottom: 6px; }
    label {
      display: block;
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 3px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .input-row {
      display: flex;
      align-items: center;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      padding: 0 4px 0 7px;
      height: 24px;
      gap: 2px;
    }
    .input-row:focus-within { border-color: var(--vscode-focusBorder); }
    input {
      flex: 1; min-width: 0;
      background: transparent; border: none; outline: none;
      color: var(--vscode-input-foreground);
      font: inherit;
    }
    input::placeholder { color: var(--vscode-input-placeholderForeground); opacity: 1; }
    .pick-btn {
      flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      background: transparent; border: none; outline: none;
      color: var(--vscode-input-foreground);
      opacity: 0.6;
      cursor: pointer;
      padding: 0 2px;
      height: 100%;
      font-size: 14px;
      line-height: 1;
    }
    .pick-btn:hover { opacity: 1; }
    .compare-btn {
      width: 100%;
      margin-top: 8px;
      padding: 4px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      border-radius: 2px;
    }
    .compare-btn:hover { background: var(--vscode-button-hoverBackground); }
    .compare-btn:active { opacity: 0.85; }
    #vtip { display: none; position: fixed; background: var(--vscode-editorHoverWidget-background); border: 1px solid var(--vscode-editorHoverWidget-border); color: var(--vscode-editorHoverWidget-foreground); padding: 2px 6px; font-size: 0.85em; white-space: nowrap; pointer-events: none; z-index: 1000; box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,0.36)); }
  </style>
</head>
<body>
  <div class="field">
    <label>Base</label>
    <div class="input-row">
      <input id="ref1" type="text" placeholder="Branch, tag, SHA, HEAD\u2026" autocomplete="off" spellcheck="false" />
      <button class="pick-btn" id="pick1" data-vtip="Choose from branches, tags, and commits">
        <i class="codicon codicon-git-branch"></i>
      </button>
    </div>
  </div>
  <div class="field">
    <label>Compare</label>
    <div class="input-row">
      <input id="ref2" type="text" placeholder="Branch, tag, SHA, HEAD\u2026" autocomplete="off" spellcheck="false" />
      <button class="pick-btn" id="pick2" data-vtip="Choose from branches, tags, and commits">
        <i class="codicon codicon-git-branch"></i>
      </button>
    </div>
  </div>
  <button class="compare-btn" id="btn">Compare</button>
  <div id="vtip"></div>
  <script>
    const vsc = acquireVsCodeApi();

    function normalizeRef(s) {
      return s.trim().toLowerCase() === 'working directory' ? '' : s.trim();
    }
    function doCompare() {
      const ref1 = normalizeRef(document.getElementById('ref1').value);
      const ref2 = normalizeRef(document.getElementById('ref2').value);
      vsc.postMessage({ type: 'compare', ref1, ref2 });
    }

    document.getElementById('btn').addEventListener('click', doCompare);

    document.getElementById('pick1').addEventListener('click', () => {
      vsc.postMessage({ type: 'pickRef', slot: 1 });
    });
    document.getElementById('pick2').addEventListener('click', () => {
      vsc.postMessage({ type: 'pickRef', slot: 2 });
    });

    document.getElementById('ref1').addEventListener('keydown', e => {
      if (e.key === 'Enter') { document.getElementById('ref2').focus(); }
    });
    document.getElementById('ref2').addEventListener('keydown', e => {
      if (e.key === 'Enter') { doCompare(); }
    });

    window.addEventListener('message', e => {
      const msg = e.data;
      if (msg.type === 'setRef') {
        const id = msg.slot === 1 ? 'ref1' : 'ref2';
        document.getElementById(id).value = msg.value;
      }
    });
    (function() {
      var vtip = document.getElementById('vtip');
      var vtipT;
      document.addEventListener('mouseover', function(e) {
        var el = e.target.closest('[data-vtip]');
        clearTimeout(vtipT);
        if (!el) { vtip.style.display = 'none'; return; }
        vtipT = setTimeout(function() {
          var r = el.getBoundingClientRect();
          vtip.textContent = el.dataset.vtip;
          vtip.style.display = 'block';
          vtip.style.left = r.left + 'px';
          vtip.style.top = (r.bottom + 4) + 'px';
          var tr = vtip.getBoundingClientRect();
          if (tr.bottom > window.innerHeight - 4) { vtip.style.top = Math.max(4, r.top - tr.height - 4) + 'px'; }
          if (tr.right > window.innerWidth - 4) { vtip.style.left = Math.max(4, window.innerWidth - tr.width - 4) + 'px'; }
        }, 500);
      });
      document.addEventListener('mouseout', function(e) {
        if (!e.target.closest('[data-vtip]')) { return; }
        clearTimeout(vtipT);
        vtip.style.display = 'none';
      });
    })();
  </script>
</body>
</html>`;
}
