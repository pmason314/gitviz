import * as vscode from 'vscode';
import { GitService } from '../git/GitService';
import { CommitEntry } from '../git/types';

export class CommitsView implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'gitlite.commits';

    private _view?: vscode.WebviewView;
    private cachedCommits: CommitEntry[] = [];
    private cachedAuthors: string[] = [];

    constructor(private readonly gitService: GitService) {}

    async refresh(): Promise<void> {
        try {
            this.cachedCommits = await this.gitService.getCommitsOnBranch(undefined, 200);
        } catch {
            this.cachedCommits = [];
        }
        try {
            const contributors = await this.gitService.getContributors();
            this.cachedAuthors = contributors.map(c => c.name).filter(Boolean);
        } catch {
            this.cachedAuthors = [];
        }
        this._sendUpdate();
        this._sendAuthors();
    }

    setFilter(value: string): void {
        this._view?.webview.postMessage({ type: 'setFilter', value });
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._getHtml();

        webviewView.webview.onDidReceiveMessage(async (msg: { type: string; sha?: string }) => {
            switch (msg.type) {
                case 'openCommitDetails':
                    if (msg.sha) {
                        await vscode.commands.executeCommand('gitlite.openCommitDetails', msg.sha);
                    }
                    break;
                case 'openGraph':
                    if (msg.sha) {
                        await vscode.commands.executeCommand('gitlite.openCommitGraph', msg.sha);
                    }
                    break;
                case 'copySha':
                    if (msg.sha) {
                        await vscode.env.clipboard.writeText(msg.sha);
                        vscode.window.showInformationMessage(`GitLite: Copied ${msg.sha.slice(0, 7)} to clipboard.`);
                    }
                    break;
            }
        });

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this._sendUpdate();
                this._sendAuthors();
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
            shortAuthor: c.author ? c.author.split(/[\s@]/)[0] : '',
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

    dispose(): void { /* nothing to dispose */ }

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
  overflow-x: clip;}
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
  position: relative;
  display: flex; align-items: center;
  padding: 1px 20px 1px 20px;
  min-height: 22px;
  cursor: pointer; gap: 0;
}
.row:hover { background: var(--vscode-list-hoverBackground); }
.msg {
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  flex-shrink: 1; min-width: 0;
}
.date-first {
  flex: 0 0 auto;
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
  margin-left: 6px;
  white-space: nowrap;
}
.auth-rest {
  flex: 0 9999 auto; min-width: 0;
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
  white-space: nowrap; overflow: hidden;
}
.copy-btn, .graph-btn {
  display: none; align-items: center; justify-content: center;
  background: none; border: none;
  color: var(--vscode-icon-foreground, var(--vscode-foreground));
  opacity: 0.55; cursor: pointer; padding: 2px; border-radius: 3px;
  margin-left: 4px; flex-shrink: 0;
}
.graph-btn { margin-left: 0; margin-right: 4px; }
.row:hover .copy-btn, .row:hover .graph-btn { display: flex; }
.copy-btn:hover, .graph-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
.empty { padding: 6px 20px; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
#vtip { display: none; position: fixed; background: var(--vscode-editorHoverWidget-background); border: 1px solid var(--vscode-editorHoverWidget-border); color: var(--vscode-editorHoverWidget-foreground); padding: 2px 6px; font-size: 0.85em; white-space: nowrap; pointer-events: none; z-index: 1000; box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,0.36)); }
#tip {
  display: none;
  position: fixed;
  background: var(--vscode-editorHoverWidget-background);
  border: 1px solid var(--vscode-editorHoverWidget-border);
  color: var(--vscode-editorHoverWidget-foreground);
  padding: 3px 8px;
  max-width: calc(100vw - 16px);
  font-size: 0.9em; line-height: 1.4;
  white-space: normal; overflow-wrap: break-word;
  box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,0.36));
  pointer-events: none;
  z-index: 100;
}
.tip-meta { font-size: 0.85em; opacity: 0.8; margin-top: 2px; }
.tip-sha { font-family: var(--vscode-editor-font-family, monospace); }
#suggest {
  display: none;
  position: sticky;
  top: 34px;
  z-index: 20;
  background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  border: 1px solid var(--vscode-editorWidget-border, var(--vscode-focusBorder));
  border-top: none;
  max-height: 160px;
  overflow-y: auto;
}
.sg-item {
  padding: 2px 12px;
  min-height: 22px;
  line-height: 22px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sg-item:hover, .sg-item.active { background: var(--vscode-list-hoverBackground); }
</style>
</head>
<body>
<div class="search-wrap">
  <div class="search-row">
    <svg class="s-icon" viewBox="0 0 16 16" fill="currentColor">
      <path d="M6.5 1a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zm-4.5 5.5a4.5 4.5 0 1 1 9 0 4.5 4.5 0 0 1-9 0zm11.854 7.354-3-3-.708.708 3 3 .708-.708z"/>
    </svg>
    <input class="s-input" id="f" type="text" placeholder="Filter by message, SHA, or @author\u2026" autocomplete="off" spellcheck="false"/>
    <button class="s-clear" id="c" data-vtip="Clear filter">\u2715</button>
  </div>
</div>
<div id="suggest"></div>
<div id="list"></div>
<div id="tip"></div>
<div id="vtip"></div>
<script>
var vsc = acquireVsCodeApi();
var inp = document.getElementById('f');
var clr = document.getElementById('c');
var lst = document.getElementById('list');
var sug = document.getElementById('suggest');
var tip = document.getElementById('tip');
var tipTimer;
var allCommits = [];
var allAuthors = [];
var activeIdx = -1;

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

var copySvg = '<svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">'
  + '<path d="M4 4v-3h9v11h-3v1h-9v-11h3zm1 0h5v9h2v-9h-7v0zm-1 1h-2v9h7v-9h-5z"/>'
  + '</svg>';
var graphSvg = '<svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">'
  + '<circle cx="3" cy="3" r="2"/>'
  + '<circle cx="3" cy="13" r="2"/>'
  + '<circle cx="13" cy="8" r="2"/>'
  + '<line x1="3" y1="5" x2="3" y2="11" stroke="currentColor" stroke-width="1.5"/>'
  + '<line x1="5" y1="3" x2="11" y2="7" stroke="currentColor" stroke-width="1.5"/>'
  + '<line x1="5" y1="13" x2="11" y2="9" stroke="currentColor" stroke-width="1.5"/>'
  + '</svg>';

function showSuggest(matches) {
  if (!matches.length) { hideSuggest(); return; }
  activeIdx = -1;
  sug.innerHTML = matches.map(function(n, i) {
    return '<div class="sg-item" data-idx="' + i + '" data-name="' + esc(n) + '">@' + esc(n) + '</div>';
  }).join('');
  sug.style.display = 'block';
}

function hideSuggest() {
  sug.style.display = 'none';
  sug.innerHTML = '';
  activeIdx = -1;
}

function applySuggestion(name) {
  inp.value = '@' + name;
  clr.style.display = 'flex';
  hideSuggest();
  render();
  inp.focus();
}

function render() {
  var raw = inp.value;
  var q = raw.toLowerCase().trim();
  var shown;
  if (q.startsWith('@')) {
    var afterAt = q.slice(1);
    var matchedAuthor = '';
    for (var ai = 0; ai < allAuthors.length; ai++) {
      var aLower = allAuthors[ai].toLowerCase();
      if (afterAt.startsWith(aLower) && aLower.length > matchedAuthor.length) {
        matchedAuthor = aLower;
      }
    }
    var aq, mq;
    if (matchedAuthor) {
      aq = matchedAuthor;
      mq = afterAt.slice(matchedAuthor.length).trim();
    } else {
      aq = afterAt;
      mq = '';
    }
    var mqWords = mq.split(/\s+/).filter(Boolean);
    shown = allCommits.filter(function(c) {
      var authorMatch = !aq || (c.author && c.author.toLowerCase().indexOf(aq) >= 0);
      var msgMatch = mqWords.length === 0 || mqWords.every(function(w) {
        return c.message.toLowerCase().indexOf(w) >= 0;
      });
      return authorMatch && msgMatch;
    });
  } else {
    shown = q
      ? allCommits.filter(function(c) {
          return c.message.toLowerCase().indexOf(q) >= 0
            || (c.author && c.author.toLowerCase().indexOf(q) >= 0)
            || c.sha.indexOf(q) >= 0;
        })
      : allCommits;
  }

  if (!shown.length) {
    lst.innerHTML = '<div class="empty">' + esc(q ? 'No commits matching "' + q + '"' : 'No commits') + '</div>';
    return;
  }

  lst.innerHTML = shown.map(function(c) {
    var rawRest = (c.author && c.shortAuthor && c.author.length > c.shortAuthor.length)
      ? c.author.slice(c.shortAuthor.length).trimStart()
      : '';
    var authRest = rawRest ? '\u00a0' + rawRest : '';
    var dateFirst = (c.shortDate || '') + (c.shortAuthor ? (c.shortDate ? ' \u00b7 ' : '') + c.shortAuthor : '');
    return '<div class="row" data-sha="' + esc(c.sha) + '" data-tooltip="' + esc(c.message) + '" data-date="' + esc(c.relativeDate || '') + '" data-author="' + esc(c.author || '') + '">'
      + '<button class="graph-btn" data-sha="' + esc(c.sha) + '" data-vtip="Open in Commit Graph">' + graphSvg + '</button>'
      + '<span class="msg">' + esc(c.message) + '</span>'
      + (dateFirst ? '<span class="date-first">' + esc(dateFirst) + '</span>' : '')
      + (authRest ? '<span class="auth-rest">' + esc(authRest) + '</span>' : '')
      + '<button class="copy-btn" data-sha="' + esc(c.sha) + '" data-vtip="Copy SHA">' + copySvg + '</button>'
      + '</div>';
  }).join('');
}

lst.addEventListener('click', function(e) {
  var btn = e.target.closest('.copy-btn');
  if (btn) { e.stopPropagation(); vsc.postMessage({type:'copySha', sha: btn.dataset.sha}); return; }
  var gbtn = e.target.closest('.graph-btn');
  if (gbtn) { e.stopPropagation(); vsc.postMessage({type:'openGraph', sha: gbtn.dataset.sha}); return; }
  var row = e.target.closest('.row');
  if (row) { vsc.postMessage({type:'openCommitDetails', sha: row.dataset.sha}); }
});

lst.addEventListener('mouseover', function(e) {
  var row = e.target.closest('.row');
  if (!row) { return; }
  clearTimeout(tipTimer);
  tipTimer = setTimeout(function() {
    if (!row.dataset.tooltip) { return; }
    var sha7 = row.dataset.sha ? row.dataset.sha.slice(0, 7) : '';
    var date = row.dataset.date || '';
    var author = row.dataset.author || '';
    var metaParts = [date, author].filter(Boolean).join('\u00a0\u00b7\u00a0');
    var rect = row.getBoundingClientRect();
    tip.innerHTML = '<div>' + esc(row.dataset.tooltip || '') + '</div>'
      + '<div class="tip-meta">'
      + (sha7 ? '<span class="tip-sha">' + esc(sha7) + '</span>' : '')
      + (metaParts ? (sha7 ? '\u00a0\u00b7\u00a0' : '') + esc(metaParts) : '')
      + '</div>';
    tip.style.display = 'block';
    tip.style.left = rect.left + 'px';
    tip.style.top = (rect.bottom + 2) + 'px';
    var tr = tip.getBoundingClientRect();
    if (tr.bottom > window.innerHeight - 4) { tip.style.top = Math.max(4, rect.top - tr.height - 2) + 'px'; }
    if (tr.right  > window.innerWidth  - 4) { tip.style.left = Math.max(4, window.innerWidth - tr.width - 8) + 'px'; }
  }, 600);
});

lst.addEventListener('mouseout', function(e) {
  if (!e.target.closest('.row')) { return; }
  clearTimeout(tipTimer);
  tip.style.display = 'none';
});

inp.addEventListener('input', function() {
  clr.style.display = inp.value ? 'flex' : 'none';
  var raw = inp.value;
  if (raw === '@' || (raw.startsWith('@') && !raw.includes(' '))) {
    var term = raw.slice(1).toLowerCase();
    var matches = term
      ? allAuthors.filter(function(n) { return n.toLowerCase().indexOf(term) >= 0; })
      : allAuthors.slice();
    showSuggest(matches);
  } else {
    hideSuggest();
  }
  render();
});

clr.addEventListener('click', function() {
  inp.value = ''; clr.style.display = 'none';
  hideSuggest();
  render();
  inp.focus();
});

inp.addEventListener('keydown', function(e) {
  if (sug.style.display === 'none') { return; }
  var items = sug.querySelectorAll('.sg-item');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (activeIdx > 0) { items[activeIdx].classList.remove('active'); }
    activeIdx = Math.min(activeIdx + 1, items.length - 1);
    items[activeIdx].classList.add('active');
    items[activeIdx].scrollIntoView({block:'nearest'});
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (activeIdx >= 0) { items[activeIdx].classList.remove('active'); }
    activeIdx = Math.max(activeIdx - 1, 0);
    items[activeIdx].classList.add('active');
    items[activeIdx].scrollIntoView({block:'nearest'});
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    if (activeIdx >= 0) {
      e.preventDefault();
      applySuggestion(items[activeIdx].dataset.name);
    }
  } else if (e.key === 'Escape') {
    hideSuggest();
  }
});

sug.addEventListener('mousedown', function(e) {
  var item = e.target.closest('.sg-item');
  if (item) { e.preventDefault(); applySuggestion(item.dataset.name); }
});

window.addEventListener('message', function(e) {
  var msg = e.data;
  if (msg.type === 'update') {
    allCommits = msg.commits || [];
    render();
  } else if (msg.type === 'setFilter') {
    inp.value = msg.value || '';
    clr.style.display = inp.value ? 'flex' : 'none';
    hideSuggest();
    render();
    inp.focus();
  } else if (msg.type === 'setAuthors') {
    allAuthors = (msg.names || []).map(function(n) { return n.trim(); }).filter(Boolean);
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
}
