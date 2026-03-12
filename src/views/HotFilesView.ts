import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from '../git/GitService';
import { HotFileEntry } from '../git/types';

export type Timeframe = 7 | 30 | 90 | null;

export const TIMEFRAME_LABELS: Record<string, string> = {
    '7':    'Last 7 days',
    '30':   'Last 30 days',
    '90':   'Last 90 days',
    'null': 'All time',
};

function matchesFilter(filePath: string, filter: string): boolean {
    if (!filter) { return true; }
    const norm = filePath.replace(/\\/g, '/');
    if (!/[*?]/.test(filter)) {
        return norm.toLowerCase().includes(filter.toLowerCase());
    }
    const reSource = filter
        .replace(/\\/g, '/')
        .replace(/[.+^${}()|[\]]/g, '\\$&')
        .replace(/\*\*/g, '\x00')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/\x00/g, '.*');
    try { return new RegExp(reSource, 'i').test(norm); } catch { return false; }
}

export class HotFilesView implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'gitlite.hotFiles';

    private _view?: vscode.WebviewView;
    private _onActiveTimeframeChanged = new vscode.EventEmitter<string>();
    readonly onActiveTimeframeChanged = this._onActiveTimeframeChanged.event;

    private userTimeframe: Timeframe = 30;
    private filter = '';
    private cachedFiles: HotFileEntry[] = [];

    constructor(private readonly gitService: GitService) {}

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._getHtml();
        webviewView.description = TIMEFRAME_LABELS['30'];

        webviewView.webview.onDidReceiveMessage(async (msg: { type: string; path?: string; value?: string }) => {
            switch (msg.type) {
                case 'filter':
                    this.filter = (msg.value ?? '').trim();
                    this._sendFiltered();
                    break;
                case 'openFile': {
                    if (!msg.path) { break; }
                    const uri = vscode.Uri.file(path.join(this.gitService.getRepoRoot(), msg.path));
                    await vscode.commands.executeCommand('vscode.open', uri);
                    break;
                }
                case 'openFileHistory': {
                    if (!msg.path) { break; }
                    await vscode.commands.executeCommand(
                        'gitlite.hotFiles.openFileHistory',
                        { path: msg.path } as HotFileEntry,
                    );
                    break;
                }
            }
        });

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) { this._loadAndSend(); }
        });

        this._loadAndSend();
    }

    private async _loadAndSend(): Promise<void> {
        const since = this.userTimeframe
            ? new Date(Date.now() - this.userTimeframe * 24 * 60 * 60 * 1000)
            : null;
        try {
            this.cachedFiles = await this.gitService.getHotFiles(since);
        } catch {
            this.cachedFiles = [];
        }
        this._sendFiltered();
    }

    private _sendFiltered(): void {
        const files = this.filter
            ? this.cachedFiles.filter(e => matchesFilter(e.path, this.filter))
            : this.cachedFiles;

        let emptyMessage: string | undefined;
        if (files.length === 0) {
            emptyMessage = this.filter
                ? `No files matching "${this.filter}"`
                : this.userTimeframe
                    ? `No commits found in the last ${this.userTimeframe} days`
                    : 'No commits found';
        }
        this._view?.webview.postMessage({ type: 'update', files, emptyMessage });
    }

    setTimeframe(t: Timeframe): void {
        this.userTimeframe = t;
        const label = TIMEFRAME_LABELS[String(t)];
        if (this._view) { this._view.description = label; }
        this._onActiveTimeframeChanged.fire(label);
        this._loadAndSend();
    }

    dispose(): void {
        this._onActiveTimeframeChanged.dispose();
    }

    private _getHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: transparent;
  overflow-x: hidden;
}
.search-wrap {
  padding: 5px 8px 3px;
  position: sticky;
  top: 0;
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  z-index: 10;
}
.search-row {
  display: flex;
  align-items: center;
  gap: 5px;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 2px;
  padding: 0 7px;
  height: 24px;
}
.search-row:focus-within { border-color: var(--vscode-focusBorder); }
.s-icon { flex-shrink: 0; opacity: 0.5; width: 13px; height: 13px; }
.s-input {
  flex: 1; min-width: 0;
  background: transparent; border: none; outline: none;
  color: var(--vscode-input-foreground);
  font: inherit;
}
.s-input::placeholder { color: var(--vscode-input-placeholderForeground); opacity: 1; }
.s-clear {
  display: none; flex-shrink: 0; align-items: center; justify-content: center;
  cursor: pointer; background: none; border: none;
  color: var(--vscode-icon-foreground, var(--vscode-foreground));
  opacity: 0.6; padding: 0; font-size: 12px; line-height: 1; width: 14px; height: 14px;
}
.s-clear:hover { opacity: 1; }
.row {
  display: flex; align-items: center;
  padding: 1px 8px 1px 20px;
  min-height: 22px;
  cursor: pointer; gap: 0;
}
.row:hover { background: var(--vscode-list-hoverBackground); }
.name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 1; min-width: 0; }
.meta {
  flex-shrink: 0;
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
  margin-left: 6px;
  white-space: nowrap;
}
.hist-btn {
  display: none; align-items: center; justify-content: center;
  background: none; border: none;
  color: var(--vscode-icon-foreground, var(--vscode-foreground));
  opacity: 0.55; cursor: pointer; padding: 2px; border-radius: 3px;
  margin-left: 4px; flex-shrink: 0;
}
.row:hover .hist-btn { display: flex; }
.hist-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
.heat-high   { color: var(--vscode-gitlite-hotFile-heatHigh,   #b8784e); }
.heat-medium { color: var(--vscode-gitlite-hotFile-heatMedium, #9e8a42); }
.empty { padding: 6px 20px; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
</style>
</head>
<body>
<div class="search-wrap">
  <div class="search-row">
    <svg class="s-icon" viewBox="0 0 16 16" fill="currentColor">
      <path d="M6.5 1a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zm-4.5 5.5a4.5 4.5 0 1 1 9 0 4.5 4.5 0 0 1-9 0zm11.854 7.354-3-3-.708.708 3 3 .708-.708z"/>
    </svg>
    <input class="s-input" id="f" type="text" placeholder="Filter by path or glob\u2026" autocomplete="off" spellcheck="false"/>
    <button class="s-clear" id="c" title="Clear filter">\u2715</button>
  </div>
</div>
<div id="list"></div>
<script>
var vsc = acquireVsCodeApi();
var inp = document.getElementById('f');
var clr = document.getElementById('c');
var lst = document.getElementById('list');
var files = [];
var emptyMsg = null;

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function render() {
  if (!files.length) {
    lst.innerHTML = '<div class="empty">' + esc(emptyMsg || 'No results') + '</div>';
    return;
  }
  var n = files.length;
  lst.innerHTML = files.map(function(f, i) {
    var ratio = n > 1 ? i / (n - 1) : 0;
    var heat = ratio < 0.25 ? 'heat-high' : ratio < 0.6 ? 'heat-medium' : '';
    var slash = f.path.lastIndexOf('/');
    var name = slash >= 0 ? f.path.slice(slash + 1) : f.path;
    var dir  = slash >= 0 ? f.path.slice(0, slash) : '';
    var meta = f.count + ' commits' + (dir ? ' \u00b7 ' + dir : '');
    var histSvg = '<svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">'
      + '<path d="M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM1 8a7 7 0 1 1 14 0A7 7 0 0 1 1 8z"/>'
      + '<path d="M7.5 4.5v3.72l2.64 2.64.72-.72-2.36-2.36V4.5z"/>'
      + '</svg>';
    return '<div class="row" data-path="' + esc(f.path) + '">'
      + '<span class="name ' + heat + '">' + esc(name) + '</span>'
      + '<span class="meta">' + esc(meta) + '</span>'
      + '<button class="hist-btn" data-path="' + esc(f.path) + '" title="Open File History">' + histSvg + '</button>'
      + '</div>';
  }).join('');
}

lst.addEventListener('click', function(e) {
  var btn = e.target.closest('.hist-btn');
  if (btn) { e.stopPropagation(); vsc.postMessage({type:'openFileHistory', path: btn.dataset.path}); return; }
  var row = e.target.closest('.row');
  if (row) { vsc.postMessage({type:'openFile', path: row.dataset.path}); }
});

inp.addEventListener('input', function() {
  clr.style.display = inp.value ? 'flex' : 'none';
  vsc.postMessage({type:'filter', value: inp.value});
});

clr.addEventListener('click', function() {
  inp.value = ''; clr.style.display = 'none';
  vsc.postMessage({type:'filter', value: ''});
  inp.focus();
});

window.addEventListener('message', function(e) {
  var msg = e.data;
  if (msg.type === 'update') {
    files = msg.files || [];
    emptyMsg = msg.emptyMessage || null;
    render();
  }
});
</script>
</body>
</html>`;
    }
}
