import * as vscode from 'vscode';

export class HotFilesSearchView implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'gitlite.hotFilesSearch';

    private _view?: vscode.WebviewView;
    private _onDidChangeFilter = new vscode.EventEmitter<string>();
    readonly onDidChangeFilter = this._onDidChangeFilter.event;

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._getHtml();
        webviewView.webview.onDidReceiveMessage(msg => {
            if (msg.type === 'filter') {
                this._onDidChangeFilter.fire(msg.value as string);
            }
        });
    }

    /** Sync the input value when the filter is cleared from outside (e.g. programmatic clearFilter). */
    setValue(value: string): void {
        this._view?.webview.postMessage({ type: 'setValue', value });
    }

    private _getHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { padding: 5px 8px; background: transparent; overflow: hidden; }
  .row {
    display: flex;
    align-items: center;
    gap: 5px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
    border-radius: 2px;
    padding: 0 7px;
    height: 26px;
  }
  .row:focus-within { border-color: var(--vscode-focusBorder); }
  .icon { flex-shrink: 0; opacity: 0.55; width: 13px; height: 13px; }
  input {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    outline: none;
    color: var(--vscode-input-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
  input::placeholder { color: var(--vscode-input-placeholderForeground); opacity: 1; }
  .clear {
    display: none;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    background: none;
    border: none;
    color: var(--vscode-icon-foreground, var(--vscode-foreground));
    opacity: 0.55;
    padding: 0;
    width: 15px;
    height: 15px;
    font-size: 13px;
    line-height: 1;
  }
  .clear:hover { opacity: 1; }
</style>
</head>
<body>
<div class="row">
  <svg class="icon" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
    <path d="M6.5 1a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zm-4.5 5.5a4.5 4.5 0 1 1 9 0 4.5 4.5 0 0 1-9 0zm11.854 7.354-3-3-.708.708 3 3 .708-.708z"/>
  </svg>
  <input id="filter" type="text" placeholder="Filter by path or glob…" autocomplete="off" spellcheck="false" />
  <button class="clear" id="clear" title="Clear filter">✕</button>
</div>
<script>
  const vscode = acquireVsCodeApi();
  const input = document.getElementById('filter');
  const clear = document.getElementById('clear');

  input.addEventListener('input', () => {
    const v = input.value;
    clear.style.display = v ? 'flex' : 'none';
    vscode.postMessage({ type: 'filter', value: v });
  });

  clear.addEventListener('click', () => {
    input.value = '';
    clear.style.display = 'none';
    vscode.postMessage({ type: 'filter', value: '' });
    input.focus();
  });

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'setValue') {
      input.value = msg.value ?? '';
      clear.style.display = msg.value ? 'flex' : 'none';
    }
  });
</script>
</body>
</html>`;
    }

    dispose(): void {
        this._onDidChangeFilter.dispose();
    }
}
