import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GitService } from '../git/GitService';
import { HotFileEntry } from '../git/types';

export type Timeframe = 7 | 30 | 90 | null;

export const TIMEFRAME_LABELS: Record<string, string> = {
    '7':    'Last 7 days',
    '30':   'Last 30 days',
    '90':   'Last 90 days',
    'null': 'All time',
};

let _lastFilterPattern = '';
let _lastFilterRegex: RegExp | null = null;

function matchesFilter(filePath: string, filter: string): boolean {
    if (!filter) { return true; }
    const norm = filePath.replace(/\\/g, '/');
    if (!/[*?]/.test(filter)) {
        return norm.toLowerCase().includes(filter.toLowerCase());
    }
    if (filter !== _lastFilterPattern) {
        const reSource = filter
            .replace(/\\/g, '/')
            .replace(/[.+^${}()|[\]]/g, '\\$&')
            .replace(/\*\*/g, '\x00')
            .replace(/\*/g, '[^/]*')
            .replace(/\?/g, '[^/]')
            .replace(/\x00/g, '.*');
        try { _lastFilterRegex = new RegExp(reSource, 'i'); } catch { _lastFilterRegex = null; }
        _lastFilterPattern = filter;
    }
    return _lastFilterRegex ? _lastFilterRegex.test(norm) : false;
}

export class HotFilesView implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'gitviz.hotFiles';

    private _view?: vscode.WebviewView;
    private _onActiveTimeframeChanged = new vscode.EventEmitter<string>();
    readonly onActiveTimeframeChanged = this._onActiveTimeframeChanged.event;

    private userTimeframe: Timeframe = 30;
    private filter = '';
    private hideDeleted = false;
    private cachedFiles: HotFileEntry[] = [];

    constructor(private readonly gitService: GitService, private readonly extensionUri: vscode.Uri) {}

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = fs.readFileSync(path.join(this.extensionUri.fsPath, 'resources', 'hotFilesView.html'), 'utf8');
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
                        'gitviz.hotFiles.openFileHistory',
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
        // Annotate each file with whether it currently exists on disk
        const root = this.gitService.getRepoRoot();
        await Promise.all(this.cachedFiles.map(async (f) => {
            const absPath = path.join(root, f.path);
            try {
                await vscode.workspace.fs.stat(vscode.Uri.file(absPath));
                (f as HotFileEntry & { exists?: boolean }).exists = true;
            } catch {
                (f as HotFileEntry & { exists?: boolean }).exists = false;
            }
        }));
        this._sendFiltered();
    }

    private _sendFiltered(): void {
        const total = this.cachedFiles.length;
        // Annotate each file with its heat class based on its rank in the *full* list
        // so the color is stable regardless of what the user types in the filter.
        const annotated = this.cachedFiles.map((f, i) => {
            const ratio = total > 1 ? i / (total - 1) : 0;
            const heat = ratio < 0.25 ? 'heat-high' : ratio < 0.6 ? 'heat-medium' : '';
            return { ...f, heat };
        });

        let files = this.filter
            ? annotated.filter(e => matchesFilter(e.path, this.filter))
            : annotated;

        if (this.hideDeleted) {
            files = files.filter(f => (f as HotFileEntry & { exists?: boolean }).exists !== false);
        }

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

    setHideDeleted(val: boolean): void {
        this.hideDeleted = val;
        this._sendFiltered();
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

}
