import * as path from 'path';
import * as vscode from 'vscode';
import { GitService } from './git/GitService';
import { BlameCache } from './git/BlameCache';
import { CommitCache } from './git/CommitCache';
import { Config } from './config/Config';
import { InlineBlame } from './annotations/InlineBlame';
import { LineHeatmap } from './annotations/LineHeatmap';
import { BlameHoverProvider } from './hovers/BlameHoverProvider';
import { FileHistoryProvider } from './views/FileHistoryProvider';
import { LineHistoryProvider } from './views/LineHistoryProvider';
import { HotFilesProvider, Timeframe } from './views/HotFilesProvider';
import { RevisionContentProvider, REVISION_SCHEME, makeRevisionUri } from './editors/RevisionContentProvider';
import { CommitDetailsPanel } from './webviews/CommitDetailsPanel';
import { FileHistoryEntry, HotFileEntry } from './git/types';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const repoRoot = await detectRepoRoot();
    if (repoRoot) {
        await initExtension(context, repoRoot);
        return;
    }

    // No repo found yet — wait for the user to open a folder
    const watcher = vscode.workspace.onDidChangeWorkspaceFolders(async () => {
        const root = await detectRepoRoot();
        if (root) {
            watcher.dispose();
            await initExtension(context, root);
        }
    });
    context.subscriptions.push(watcher);
}

async function detectRepoRoot(): Promise<string | null> {
    const folders = vscode.workspace.workspaceFolders;
    if (folders) {
        for (const folder of folders) {
            const root = await GitService.findRepoRoot(folder.uri.fsPath);
            if (root) { return root; }
        }
    }
    // Fallback: try the active editor's file (e.g. when no folder is open)
    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (activeFile) {
        return GitService.findRepoRoot(activeFile);
    }
    return null;
}

async function initExtension(context: vscode.ExtensionContext, repoRoot: string): Promise<void> {

    // -------------------------------------------------------------------------
    // Core services
    // -------------------------------------------------------------------------
    const blameCache = new BlameCache();
    const commitCache = new CommitCache();
    const config = new Config();
    const gitService = GitService.getInstance(repoRoot, blameCache, commitCache);

    // -------------------------------------------------------------------------
    // Feature classes
    // -------------------------------------------------------------------------
    const inlineBlame = new InlineBlame(gitService, config);
    const heatmap = new LineHeatmap(gitService, config);
    const hoverProvider = new BlameHoverProvider(gitService, config);
    const fileHistoryProvider = new FileHistoryProvider(gitService);
    const lineHistoryProvider = new LineHistoryProvider(gitService);
    const hotFilesProvider = new HotFilesProvider(gitService);
    const revisionProvider = new RevisionContentProvider(gitService);
    const commitDetailsPanel = new CommitDetailsPanel(gitService);

    // -------------------------------------------------------------------------
    // Register providers
    // -------------------------------------------------------------------------
    context.subscriptions.push(
        inlineBlame,
        heatmap,
        hoverProvider,
        fileHistoryProvider,
        lineHistoryProvider,
        hotFilesProvider,
        revisionProvider,
        commitDetailsPanel,
        vscode.languages.registerHoverProvider({ scheme: 'file' }, hoverProvider),
        vscode.window.registerTreeDataProvider('gitlite.fileHistory', fileHistoryProvider),
        vscode.window.registerTreeDataProvider('gitlite.lineHistory', lineHistoryProvider),
        vscode.window.registerTreeDataProvider('gitlite.hotFiles', hotFilesProvider),
        vscode.workspace.registerTextDocumentContentProvider(REVISION_SCHEME, revisionProvider),
    );

    // -------------------------------------------------------------------------
    // Subscribe to save events — invalidate cache and refresh all annotations
    // -------------------------------------------------------------------------
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((document) => {
            blameCache.invalidate(document.uri.fsPath);
            inlineBlame.onFileSaved(document);
            heatmap.onFileSaved(document);
        })
    );

    // -------------------------------------------------------------------------
    // Commands
    // -------------------------------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('gitlite.toggleBlame', () => {
            inlineBlame.toggle();
        }),

        vscode.commands.registerCommand('gitlite.toggleHeatmap', () => {
            heatmap.toggle();
        }),

        vscode.commands.registerCommand('gitlite.copySha', async (arg?: string | FileHistoryEntry) => {
            let sha: string | undefined;
            if (typeof arg === 'string') {
                sha = arg;
            } else if (arg && typeof arg === 'object' && 'sha' in arg) {
                sha = (arg as FileHistoryEntry).sha;
            } else {
                sha = await promptForSha();
            }
            if (sha) {
                await vscode.env.clipboard.writeText(sha);
                vscode.window.showInformationMessage(`GitLite: Copied ${sha.slice(0, 7)} to clipboard.`);
            }
        }),

        vscode.commands.registerCommand('gitlite.openCommitDetails', async (arg?: string | FileHistoryEntry) => {
            const sha = typeof arg === 'string' ? arg
                : (arg && 'sha' in arg) ? arg.sha
                : undefined;
            if (sha) {
                await commitDetailsPanel.show(sha).catch((err: Error) => {
                    vscode.window.showErrorMessage(`GitLite: ${err.message}`);
                });
            }
        }),

        vscode.commands.registerCommand('gitlite.diffWithPrevious', async (args?: { sha: string; filePath: string }) => {
            if (!args) {
                const editor = vscode.window.activeTextEditor;
                if (!editor || editor.document.uri.scheme !== 'file') {
                    vscode.window.showWarningMessage('GitLite: Open a file to use Diff with Previous.');
                    return;
                }
                const blame = await gitService.getBlameForFile(editor.document.uri.fsPath);
                const blameInfo = blame.get(editor.selection.active.line + 1);
                if (!blameInfo) {
                    vscode.window.showWarningMessage('GitLite: No blame info for current line.');
                    return;
                }
                args = { sha: blameInfo.sha, filePath: editor.document.uri.fsPath };
            }
            const repoRoot = gitService.getRepoRoot();
            const prevUri = makeRevisionUri(repoRoot, `${args.sha}~1`, args.filePath);
            const currUri = makeRevisionUri(repoRoot, args.sha, args.filePath);
            const title = `${path.basename(args.filePath)} (${args.sha.slice(0, 7)}^ ↔ ${args.sha.slice(0, 7)})`;
            await vscode.commands.executeCommand('vscode.diff', prevUri, currUri, title);
        }),

        vscode.commands.registerCommand('gitlite.revealCommit', (_sha?: string) => {
            vscode.window.showInformationMessage('GitLite: Commits view coming in Phase 3.');
        }),

        // ---------------------------------------------------------------------
        // Phase 2 — File / Line History commands
        // ---------------------------------------------------------------------

        vscode.commands.registerCommand('gitlite.openLineHistory', async () => {
            await vscode.commands.executeCommand('gitlite.lineHistory.focus');
        }),

        vscode.commands.registerCommand('gitlite.lineHistory.openDiff', async (sha: string) => {
            const filePath = lineHistoryProvider.getCurrentFilePath();
            if (!filePath) { return; }
            const line = lineHistoryProvider.getCurrentLine(); // 1-based
            const repoRoot = gitService.getRepoRoot();
            const prevUri = makeRevisionUri(repoRoot, `${sha}~1`, filePath);
            const currUri = makeRevisionUri(repoRoot, sha, filePath);
            const title = `${path.basename(filePath)} (${sha.slice(0, 7)}^ \u2194 ${sha.slice(0, 7)})`;
            // Reveal the tracked line (0-based) in the right side of the diff
            const selection = line > 0
                ? new vscode.Range(line - 1, 0, line - 1, 0)
                : undefined;
            await vscode.commands.executeCommand('vscode.diff', prevUri, currUri, title,
                { viewColumn: vscode.ViewColumn.Active, selection });
        }),

        vscode.commands.registerCommand('gitlite.fileHistory.openAtRevision', async (entry: FileHistoryEntry) => {
            const filePath = fileHistoryProvider.getCurrentFilePath();
            if (!filePath) { return; }
            const uri = makeRevisionUri(gitService.getRepoRoot(), entry.sha, filePath);
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, { preview: true });
        }),

        vscode.commands.registerCommand('gitlite.fileHistory.diffWithPrevious', async (entry: FileHistoryEntry) => {
            const filePath = fileHistoryProvider.getCurrentFilePath();
            if (!filePath) { return; }
            const repoRoot = gitService.getRepoRoot();
            const prevUri = makeRevisionUri(repoRoot, `${entry.sha}~1`, filePath);
            const currUri = makeRevisionUri(repoRoot, entry.sha, filePath);
            const title = `${path.basename(filePath)} (${entry.sha.slice(0, 7)}^ ↔ ${entry.sha.slice(0, 7)})`;
            await vscode.commands.executeCommand('vscode.diff', prevUri, currUri, title);
        }),

        vscode.commands.registerCommand('gitlite.fileHistory.openCommitDetails', async (entry: string | FileHistoryEntry) => {
            const sha = typeof entry === 'string' ? entry : entry.sha;
            const highlightPath = fileHistoryProvider.getCurrentFilePath();
            await commitDetailsPanel.show(sha, highlightPath).catch((err: Error) => {
                vscode.window.showErrorMessage(`GitLite: ${err.message}`);
            });
        }),

        vscode.commands.registerCommand('gitlite.hotFiles.setTimeframe', async () => {
            const items: { label: string; timeframe: Timeframe }[] = [
                { label: '$(clock) Last 7 days',  timeframe: 7   },
                { label: '$(clock) Last 30 days', timeframe: 30  },
                { label: '$(clock) Last 90 days', timeframe: 90  },
                { label: '$(calendar) All time',  timeframe: null },
            ];
            const picked = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select timeframe for Hot Files',
            });
            if (picked) {
                hotFilesProvider.setTimeframe(picked.timeframe);
            }
        }),

        vscode.commands.registerCommand('gitlite.hotFiles.openFileHistory', async (entry: HotFileEntry) => {
            const absPath = path.join(gitService.getRepoRoot(), entry.path);
            fileHistoryProvider.loadForFile(absPath);
            await vscode.commands.executeCommand('gitlite.fileHistory.focus');
        }),
    );
}

export function deactivate(): void {
    GitService.resetInstance();
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

async function promptForSha(): Promise<string | undefined> {
    return vscode.window.showInputBox({
        prompt: 'Enter a commit SHA to copy',
        placeHolder: 'e.g. abc1234',
        validateInput: (v) => /^[0-9a-fA-F]{4,40}$/.test(v) ? null : 'Enter a valid hex SHA',
    });
}
