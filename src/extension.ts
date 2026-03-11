import * as vscode from 'vscode';
import { GitService } from './git/GitService';
import { BlameCache } from './git/BlameCache';
import { CommitCache } from './git/CommitCache';
import { Config } from './config/Config';
import { InlineBlame } from './annotations/InlineBlame';
import { LineHeatmap } from './annotations/LineHeatmap';
import { BlameHoverProvider } from './hovers/BlameHoverProvider';

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

    // -------------------------------------------------------------------------
    // Register providers
    // -------------------------------------------------------------------------
    context.subscriptions.push(
        inlineBlame,
        heatmap,
        hoverProvider,
        vscode.languages.registerHoverProvider({ scheme: 'file' }, hoverProvider),
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

        vscode.commands.registerCommand('gitlite.copySha', async (sha?: string) => {
            const target = sha ?? await promptForSha();
            if (target) {
                await vscode.env.clipboard.writeText(target);
                vscode.window.showInformationMessage(`GitLite: Copied ${target.slice(0, 7)} to clipboard.`);
            }
        }),

        vscode.commands.registerCommand('gitlite.openCommitDetails', (_sha?: string) => {
            vscode.window.showInformationMessage('GitLite: Full commit details panel coming in Phase 2.');
        }),

        vscode.commands.registerCommand('gitlite.diffWithPrevious', (_args?: unknown) => {
            vscode.window.showInformationMessage('GitLite: Diff with previous coming in Phase 2.');
        }),

        vscode.commands.registerCommand('gitlite.revealCommit', (_sha?: string) => {
            vscode.window.showInformationMessage('GitLite: Commits view coming in Phase 3.');
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
