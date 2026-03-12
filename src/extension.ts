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
import { HotFilesView } from './views/HotFilesView';
import { CommitsView } from './views/CommitsView';
import { BranchesProvider } from './views/BranchesProvider';
import { TagsProvider } from './views/TagsProvider';
import { StashesProvider } from './views/StashesProvider';
import { CompareView } from './views/CompareView';
import { ComparePanel } from './webviews/ComparePanel';
import { RevisionContentProvider, REVISION_SCHEME, makeRevisionUri } from './editors/RevisionContentProvider';
import { CommitDetailsPanel } from './webviews/CommitDetailsPanel';
import { FileHistoryEntry, HotFileEntry, StashInfo, BranchInfo, TagInfo } from './git/types';

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
    const hotFilesView = new HotFilesView(gitService);
    const commitsView = new CommitsView(gitService);
    const branchesProvider = new BranchesProvider(gitService);
    const tagsProvider = new TagsProvider(gitService);
    const stashesProvider = new StashesProvider(gitService);
    const compareView = new CompareView(gitService, context.extensionUri);
    const comparePanel = new ComparePanel(gitService);
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
        hotFilesView,
        commitsView,
        branchesProvider,
        tagsProvider,
        stashesProvider,
        compareView,
        comparePanel,
        revisionProvider,
        commitDetailsPanel,
        vscode.languages.registerHoverProvider({ scheme: 'file' }, hoverProvider),
        vscode.window.registerTreeDataProvider('gitlite.fileHistory', fileHistoryProvider),
        vscode.window.registerTreeDataProvider('gitlite.lineHistory', lineHistoryProvider),
        vscode.workspace.registerTextDocumentContentProvider(REVISION_SCHEME, revisionProvider),
        vscode.window.registerWebviewViewProvider(HotFilesView.viewType, hotFilesView),
        vscode.window.registerWebviewViewProvider(CommitsView.viewType, commitsView),
        vscode.window.createTreeView('gitlite.branches',     { treeDataProvider: branchesProvider,     showCollapseAll: false }),
        vscode.window.createTreeView('gitlite.tags',         { treeDataProvider: tagsProvider,         showCollapseAll: false }),
        vscode.window.createTreeView('gitlite.stashes',      { treeDataProvider: stashesProvider,      showCollapseAll: false }),
        vscode.window.registerWebviewViewProvider(CompareView.viewType, compareView),
    );

    // Eagerly load Phase 3 views
    void branchesProvider.refresh();
    void tagsProvider.refresh();
    void stashesProvider.refresh();

    // -------------------------------------------------------------------------
    // Watch .git directory for local state changes and auto-refresh views
    // -------------------------------------------------------------------------
    {
        const gitDir = vscode.Uri.file(gitService.getRepoRoot() + '/.git');

        // Debounce helpers — coalesces rapid multi-file changes (e.g. during checkout)
        let branchTimer: ReturnType<typeof setTimeout> | undefined;
        let tagTimer:    ReturnType<typeof setTimeout> | undefined;
        let stashTimer:  ReturnType<typeof setTimeout> | undefined;
        const debounceBranches = () => { clearTimeout(branchTimer); branchTimer = setTimeout(() => void branchesProvider.refresh(), 300); };
        const debounceTags     = () => { clearTimeout(tagTimer);    tagTimer    = setTimeout(() => void tagsProvider.refresh(),    300); };
        const debounceStashes  = () => { clearTimeout(stashTimer);  stashTimer  = setTimeout(() => void stashesProvider.refresh(), 300); };

        // HEAD changes on checkout
        const watchHead = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(gitDir, 'HEAD'));
        // branch refs
        const watchRefs = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(gitDir, 'refs/heads/**'));
        // packed-refs covers both branches and tags after fetch/gc
        const watchPacked = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(gitDir, 'packed-refs'));
        // tag refs
        const watchTags = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(gitDir, 'refs/tags/**'));
        // stash
        const watchStash = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(gitDir, 'refs/stash'));

        for (const w of [watchHead, watchRefs]) {
            w.onDidCreate(debounceBranches);
            w.onDidChange(debounceBranches);
            w.onDidDelete(debounceBranches);
        }
        watchPacked.onDidCreate(() => { debounceBranches(); debounceTags(); });
        watchPacked.onDidChange(() => { debounceBranches(); debounceTags(); });
        for (const w of [watchTags]) {
            w.onDidCreate(debounceTags);
            w.onDidChange(debounceTags);
            w.onDidDelete(debounceTags);
        }
        for (const w of [watchStash]) {
            w.onDidCreate(debounceStashes);
            w.onDidChange(debounceStashes);
            w.onDidDelete(debounceStashes);
        }

        context.subscriptions.push(watchHead, watchRefs, watchPacked, watchTags, watchStash);
    }

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

        vscode.commands.registerCommand('gitlite.revealCommit', async (sha?: string) => {
            if (!sha) { return; }
            // Focus the Commits view panel, then filter to this SHA
            await vscode.commands.executeCommand(`${CommitsView.viewType}.focus`);
            commitsView.setFilter(sha.slice(0, 7));
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

        vscode.commands.registerCommand('gitlite.hotFiles.set7',   () => { hotFilesView.setTimeframe(7);    }),
        vscode.commands.registerCommand('gitlite.hotFiles.set30',  () => { hotFilesView.setTimeframe(30);   }),
        vscode.commands.registerCommand('gitlite.hotFiles.set90',  () => { hotFilesView.setTimeframe(90);   }),
        vscode.commands.registerCommand('gitlite.hotFiles.setAll', () => { hotFilesView.setTimeframe(null); }),
        vscode.commands.registerCommand('gitlite.hotFiles.hideDeleted', () => {
            hotFilesView.setHideDeleted(true);
            void vscode.commands.executeCommand('setContext', 'gitlite.hotFiles.hideDeleted', true);
        }),
        vscode.commands.registerCommand('gitlite.hotFiles.showDeleted', () => {
            hotFilesView.setHideDeleted(false);
            void vscode.commands.executeCommand('setContext', 'gitlite.hotFiles.hideDeleted', false);
        }),

        vscode.commands.registerCommand('gitlite.hotFiles.openFileHistory', async (entry: HotFileEntry) => {
            const absPath = path.join(gitService.getRepoRoot(), entry.path);
            fileHistoryProvider.loadForFile(absPath);
            await vscode.commands.executeCommand('gitlite.fileHistory.focus');
        }),

        // ---------------------------------------------------------------------
        // Phase 3 — Commits view
        // ---------------------------------------------------------------------

        // ---------------------------------------------------------------------
        // Phase 3 — Branches view
        // ---------------------------------------------------------------------

        vscode.commands.registerCommand('gitlite.branches.filterUntracked', () => {
            branchesProvider.setShowUntracked(true);
            void vscode.commands.executeCommand('setContext', 'gitlite.branches.showUntracked', true);
        }),

        vscode.commands.registerCommand('gitlite.branches.showAllBranches', () => {
            branchesProvider.setShowUntracked(false);
            void vscode.commands.executeCommand('setContext', 'gitlite.branches.showUntracked', false);
        }),

        vscode.commands.registerCommand('gitlite.branches.cleanupUntracked', async () => {
            const allBranches = await gitService.getBranches();
            const candidates = allBranches.filter(b => !b.isCurrent && (!b.upstream || b.upstreamGone));
            if (!candidates.length) {
                vscode.window.showInformationMessage('No local branches without an upstream to clean up.');
                return;
            }
            const items = candidates.map(b => ({
                label: b.name,
                description: b.upstreamGone ? '(upstream gone — likely merged)' : '(no upstream)',
                picked: true,
                branch: b,
            }));
            const selected = await vscode.window.showQuickPick(items, {
                canPickMany: true,
                title: 'Delete Branches Without Upstream',
                placeHolder: 'Select branches to delete (all pre-selected)',
            });
            if (!selected?.length) { return; }
            let failed = 0;
            for (const item of selected) {
                try {
                    await gitService.deleteBranch(item.branch.name);
                } catch {
                    try {
                        await gitService.deleteBranch(item.branch.name, true);
                    } catch (err) {
                        failed++;
                        vscode.window.showErrorMessage(`GitLite: Failed to delete “${item.branch.name}”: ${(err as Error).message}`);
                    }
                }
            }
            void branchesProvider.refresh();
            if (!failed) {
                const n = selected.length;
                vscode.window.showInformationMessage(`Deleted ${n} branch${n !== 1 ? 'es' : ''}.`);
            }
        }),

        vscode.commands.registerCommand('gitlite.branch.checkout', async (node: { branch?: BranchInfo }) => {
            const name = node?.branch?.name ?? await vscode.window.showInputBox({
                title: 'Switch to Branch',
                placeHolder: 'Branch name',
            });
            if (!name) { return; }
            try {
                await gitService.checkoutBranch(name);
                void branchesProvider.refresh();
                void commitsView.refresh();
                vscode.window.showInformationMessage(`GitLite: Switched to branch "${name}".`);
            } catch (err) {
                vscode.window.showErrorMessage(`GitLite: ${(err as Error).message}`);
            }
        }),

        vscode.commands.registerCommand('gitlite.branch.create', () => {
            void vscode.commands.executeCommand('git.branch');
        }),

        vscode.commands.registerCommand('gitlite.branch.delete', () => {
            void vscode.commands.executeCommand('git.deleteBranch');
        }),

        vscode.commands.registerCommand('gitlite.branch.rename', () => {
            void vscode.commands.executeCommand('git.renameBranch');
        }),

        // ---------------------------------------------------------------------
        // Phase 3 — Tags view
        // ---------------------------------------------------------------------

        vscode.commands.registerCommand('gitlite.tag.create', () => {
            void vscode.commands.executeCommand('git.createTag');
        }),

        vscode.commands.registerCommand('gitlite.tag.delete', () => {
            void vscode.commands.executeCommand('git.deleteTag');
        }),

        // ---------------------------------------------------------------------
        // Phase 3 — Stashes view
        // ---------------------------------------------------------------------

        vscode.commands.registerCommand('gitlite.stash.create', () => {
            void vscode.commands.executeCommand('git.stash');
        }),

        vscode.commands.registerCommand('gitlite.stash.dropAll', async () => {
            const stashes = await gitService.getStashes();
            if (!stashes.length) {
                vscode.window.showInformationMessage('No stashes to drop.');
                return;
            }
            const answer = await vscode.window.showWarningMessage(
                `Drop all ${stashes.length} stash${stashes.length === 1 ? '' : 'es'}? This cannot be undone.`,
                { modal: true }, 'Drop All'
            );
            if (answer !== 'Drop All') { return; }
            await gitService.dropAllStashes().catch((err: Error) => {
                vscode.window.showErrorMessage(`GitLite: ${err.message}`);
            });
        }),

        vscode.commands.registerCommand('gitlite.stash.openDetails', async (node: StashInfo) => {
            if (!node?.ref) { return; }
            await commitDetailsPanel.show(node.ref).catch((err: Error) => {
                vscode.window.showErrorMessage(`GitLite: ${err.message}`);
            });
        }),

        vscode.commands.registerCommand('gitlite.stash.applyEntry', () => {
            void vscode.commands.executeCommand('git.stashApply');
        }),

        vscode.commands.registerCommand('gitlite.stash.popEntry', () => {
            void vscode.commands.executeCommand('git.stashPop');
        }),

        vscode.commands.registerCommand('gitlite.stash.dropEntry', () => {
            void vscode.commands.executeCommand('git.stashDrop');
        }),

        // ---------------------------------------------------------------------
        // Phase 3 — Compare view
        // ---------------------------------------------------------------------

        vscode.commands.registerCommand('gitlite.compare.run', async (ref1: string, ref2: string) => {
            await comparePanel.show(ref1, ref2).catch((err: Error) => {
                vscode.window.showErrorMessage(`GitLite: ${err.message}`);
            });
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
