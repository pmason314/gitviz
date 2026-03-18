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
import { StashesProvider } from './views/StashesProvider';
import { WorktreesProvider } from './views/WorktreesProvider';
import { CompareView } from './views/CompareView';
import { ComparePanel } from './webviews/ComparePanel';
import { RevisionContentProvider, REVISION_SCHEME, makeRevisionUri } from './editors/RevisionContentProvider';
import { RebaseEditorProvider } from './editors/RebaseEditorProvider';
import { CommitMessageEditorProvider } from './editors/CommitMessageEditorProvider';
import { CommitDetailsPanel } from './webviews/CommitDetailsPanel';
import { CommitGraphPanel } from './webviews/CommitGraphPanel';
import { FileHistoryEntry, HotFileEntry, StashInfo, BranchInfo, WorktreeInfo } from './git/types';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const repoRoot = await detectRepoRoot();
    if (repoRoot) {
        await initExtension(context, repoRoot);
        return;
    }

    // No repo found yet — show stub items in tree views so the sidebar isn't blank
    const noRepo = new NoRepoProvider();
    const stubDisposables: vscode.Disposable[] = [
        vscode.window.registerTreeDataProvider('gitviz.fileHistory', noRepo),
        vscode.window.registerTreeDataProvider('gitviz.lineHistory', noRepo),
        vscode.window.createTreeView('gitviz.branches',  { treeDataProvider: noRepo, showCollapseAll: false }),
        vscode.window.createTreeView('gitviz.stashes',   { treeDataProvider: noRepo, showCollapseAll: false }),
        vscode.window.createTreeView('gitviz.worktrees', { treeDataProvider: noRepo, showCollapseAll: false }),
    ];
    context.subscriptions.push(...stubDisposables);

    // Wait for the user to open a folder with a git repo
    const watcher = vscode.workspace.onDidChangeWorkspaceFolders(async () => {
        const root = await detectRepoRoot();
        if (root) {
            watcher.dispose();
            stubDisposables.forEach(d => d.dispose());
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
    const config = new Config();
    const blameCache = new BlameCache(config.blameCacheMaxFiles());
    const commitCache = new CommitCache(config.commitCacheMaxEntries());
    const gitService = GitService.getInstance(repoRoot, blameCache, commitCache);

    // -------------------------------------------------------------------------
    // Feature classes
    // -------------------------------------------------------------------------
    const inlineBlame = new InlineBlame(gitService, config);
    const heatmap = new LineHeatmap(gitService, config);
    const hoverProvider = new BlameHoverProvider(gitService, config);
    const fileHistoryProvider = new FileHistoryProvider(gitService, config);
    const lineHistoryProvider = new LineHistoryProvider(gitService, config);
    const hotFilesView = new HotFilesView(gitService, context.extensionUri);
    const commitsView = new CommitsView(gitService, context.extensionUri);
    const branchesProvider = new BranchesProvider(gitService);
    const stashesProvider = new StashesProvider(gitService);
    const worktreesProvider = new WorktreesProvider(gitService);
    const compareView = new CompareView(gitService, context.extensionUri);
    const comparePanel = new ComparePanel(gitService);
    const revisionProvider = new RevisionContentProvider(gitService);
    const commitDetailsPanel = new CommitDetailsPanel(gitService);
    const commitGraphPanel   = CommitGraphPanel.getInstance(gitService, context.extensionUri);
    const rebaseEditorProvider = new RebaseEditorProvider(context.extensionUri);
    const commitMessageEditorProvider = new CommitMessageEditorProvider();

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
        stashesProvider,
        worktreesProvider,
        compareView,
        comparePanel,
        revisionProvider,
        commitDetailsPanel,
        commitGraphPanel,
        rebaseEditorProvider,
        vscode.window.registerCustomEditorProvider(
            RebaseEditorProvider.viewType,
            rebaseEditorProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        ),
        commitMessageEditorProvider,
        vscode.window.registerCustomEditorProvider(
            CommitMessageEditorProvider.viewType,
            commitMessageEditorProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        ),
        vscode.languages.registerHoverProvider({ scheme: 'file' }, hoverProvider),
        vscode.window.registerTreeDataProvider('gitviz.fileHistory', fileHistoryProvider),
        vscode.window.registerTreeDataProvider('gitviz.lineHistory', lineHistoryProvider),
        vscode.workspace.registerTextDocumentContentProvider(REVISION_SCHEME, revisionProvider),
        vscode.window.registerWebviewViewProvider(HotFilesView.viewType, hotFilesView),
        vscode.window.registerWebviewViewProvider(CommitsView.viewType, commitsView),
        vscode.window.createTreeView('gitviz.branches',     { treeDataProvider: branchesProvider,     showCollapseAll: false }),
        vscode.window.createTreeView('gitviz.stashes',      { treeDataProvider: stashesProvider,      showCollapseAll: false }),
        vscode.window.createTreeView('gitviz.worktrees',     { treeDataProvider: worktreesProvider,     showCollapseAll: false }),
        vscode.window.registerWebviewViewProvider(CompareView.viewType, compareView),
    );

    // Eagerly load Phase 3 views
    void branchesProvider.refresh();
    void stashesProvider.refresh();
    void worktreesProvider.refresh();

    // -------------------------------------------------------------------------
    // Watch .git directory for local state changes and auto-refresh views
    // -------------------------------------------------------------------------
    {
        const gitDir = vscode.Uri.file(gitService.getRepoRoot() + '/.git');

        // Debounce helpers — coalesces rapid multi-file changes (e.g. during checkout)
        let branchTimer:      ReturnType<typeof setTimeout> | undefined;
        let commitsTimer:     ReturnType<typeof setTimeout> | undefined;
        let historyTimer:     ReturnType<typeof setTimeout> | undefined;
        let tagTimer:         ReturnType<typeof setTimeout> | undefined;
        let stashTimer:       ReturnType<typeof setTimeout> | undefined;
        let worktreeTimer:    ReturnType<typeof setTimeout> | undefined;
        const debounceBranches  = () => { clearTimeout(branchTimer);   branchTimer   = setTimeout(() => void branchesProvider.refresh(),  300); };
        const debounceCommits   = () => { clearTimeout(commitsTimer);  commitsTimer  = setTimeout(() => void commitsView.refresh(),        300); };
        const debounceHistory   = () => { clearTimeout(historyTimer);  historyTimer  = setTimeout(() => { fileHistoryProvider.refresh(); lineHistoryProvider.refresh(); hotFilesView.refresh(); }, 300); };
        const debounceTags      = () => { clearTimeout(tagTimer);       tagTimer      = setTimeout(() => { gitService.clearTagCache(); void commitsView.refresh(); },       300); };
        const debounceStashes   = () => { clearTimeout(stashTimer);     stashTimer    = setTimeout(() => void stashesProvider.refresh(),  300); };
        const debounceWorktrees = () => { clearTimeout(worktreeTimer);  worktreeTimer = setTimeout(() => void worktreesProvider.refresh(), 300); };

        // HEAD changes on checkout
        const watchHead = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(gitDir, 'HEAD'));
        // branch refs — updated by git pull (fast-forward)
        const watchRefs = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(gitDir, 'refs/heads/**'));
        // remote tracking refs — updated by git fetch/pull
        const watchRemotes = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(gitDir, 'refs/remotes/**'));
        // packed-refs covers both branches and tags after fetch/gc
        const watchPacked = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(gitDir, 'packed-refs'));
        // tag refs
        const watchTags = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(gitDir, 'refs/tags/**'));
        // stash
        const watchStash = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(gitDir, 'refs/stash'));
        // worktrees — structural (add/remove)
        const watchWorktrees = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(gitDir, 'worktrees/**'));
        // main worktree index — staged/unstaged changes
        const watchMainIndex = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(gitDir, 'index'));
        // linked worktree indices — staged/unstaged changes in other worktrees
        const watchLinkedIndex = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(gitDir, 'worktrees/*/index'));

        for (const w of [watchHead, watchRefs]) {
            w.onDidCreate(debounceBranches);
            w.onDidChange(debounceBranches);
            w.onDidDelete(debounceBranches);
        }
        // HEAD and refs/heads changes (checkout, pull, rebase) all affect file/line
        // history and hot files commit counts
        for (const w of [watchHead, watchRefs]) {
            w.onDidCreate(debounceHistory);
            w.onDidChange(debounceHistory);
        }
        // refs/heads changes (pull) and refs/remotes changes (fetch) both
        // bring in new commits — refresh the commits view for both
        for (const w of [watchRefs, watchRemotes]) {
            w.onDidCreate(debounceCommits);
            w.onDidChange(debounceCommits);
        }
        for (const w of [watchRemotes]) {
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
        for (const w of [watchWorktrees]) {
            w.onDidCreate(debounceWorktrees);
            w.onDidChange(debounceWorktrees);
            w.onDidDelete(debounceWorktrees);
        }
        for (const w of [watchMainIndex, watchLinkedIndex]) {
            w.onDidCreate(debounceWorktrees);
            w.onDidChange(debounceWorktrees);
            w.onDidDelete(debounceWorktrees);
        }

        context.subscriptions.push(watchHead, watchRefs, watchRemotes, watchPacked, watchTags, watchStash, watchWorktrees, watchMainIndex, watchLinkedIndex);
    }

    // -------------------------------------------------------------------------
    // Refresh worktree status when VS Code regains focus (catches external changes)
    // -------------------------------------------------------------------------
    context.subscriptions.push(
        vscode.window.onDidChangeWindowState(e => {
            if (e.focused) { worktreesProvider.refresh(); }
        })
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
        vscode.commands.registerCommand('gitviz.toggleBlame', () => {
            inlineBlame.toggle();
        }),

        vscode.commands.registerCommand('gitviz.toggleHeatmap', () => {
            heatmap.toggle();
        }),

        vscode.commands.registerCommand('gitviz.copySha', async (arg?: string | FileHistoryEntry) => {
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
                vscode.window.showInformationMessage(`GitViz: Copied ${sha.slice(0, 7)} to clipboard.`);
            }
        }),

        vscode.commands.registerCommand('gitviz.openCommitDetails', async (arg?: string | FileHistoryEntry) => {
            const sha = typeof arg === 'string' ? arg
                : (arg && 'sha' in arg) ? arg.sha
                : undefined;
            if (sha) {
                await commitDetailsPanel.show(sha).catch((err: Error) => {
                    vscode.window.showErrorMessage(`GitViz: ${err.message}`);
                });
            }
        }),

        vscode.commands.registerCommand('gitviz.openCommitGraph', async (sha?: string) => {
            await commitGraphPanel.open(sha).catch((err: Error) => {
                vscode.window.showErrorMessage(`GitViz: ${err.message}`);
            });
        }),

        vscode.commands.registerCommand('gitviz.startInteractiveRebase', async () => {
            const input = await vscode.window.showInputBox({
                title: 'Interactive Rebase',
                prompt: 'Number of commits to rebase, or a base branch/SHA (e.g. 5, main, HEAD~3)',
                placeHolder: '5',
                validateInput: v => v.trim() ? undefined : 'Enter a number or a branch/SHA',
            });
            if (!input) { return; }
            const trimmed = input.trim();
            const base = /^\d+$/.test(trimmed) ? `HEAD~${trimmed}` : trimmed;
            const terminal = vscode.window.createTerminal({
                name: 'Git Rebase',
                cwd: gitService.getRepoRoot(),
                env: { GIT_SEQUENCE_EDITOR: 'code --wait' },
            });
            terminal.show();
            terminal.sendText(`git rebase -i ${base}`);
        }),

        vscode.commands.registerCommand('gitviz.revertCommit', async () => {
            const commits = await gitService.getCommitsOnBranch(undefined, 50);
            const items = commits.map(c => ({
                label: `$(git-commit) ${c.sha.slice(0, 7)}`,
                description: c.relativeDate,
                detail: `${c.author}: ${c.message}`,
                sha: c.sha,
            }));
            const picked = await vscode.window.showQuickPick(items, {
                title: 'GitViz: Revert Commit',
                placeHolder: 'Select a commit to revert…',
                matchOnDescription: true,
                matchOnDetail: true,
            });
            if (!picked) { return; }
            try {
                await gitService.revertCommit(picked.sha);
                await vscode.commands.executeCommand('gitviz.refreshAll');
                vscode.window.showInformationMessage(`GitViz: Reverted ${picked.sha.slice(0, 7)}.`);
            } catch (err) {
                vscode.window.showErrorMessage(`GitViz: Revert failed — ${(err as Error).message}`);
            }
        }),

        // Internal helper: refresh commits + branches + worktrees (used after mutating git operations)
        vscode.commands.registerCommand('gitviz.refreshAll', async () => {
            await Promise.all([
                commitsView.refresh(),
                branchesProvider.refresh(),
                worktreesProvider.refresh(),
            ]);
        }),

        vscode.commands.registerCommand('gitviz.diffWithPrevious', async (args?: { sha: string; filePath: string }) => {
            if (!args) {
                const editor = vscode.window.activeTextEditor;
                if (!editor || editor.document.uri.scheme !== 'file') {
                    vscode.window.showWarningMessage('GitViz: Open a file to use Diff with Previous.');
                    return;
                }
                const blame = await gitService.getBlameForFile(editor.document.uri.fsPath);
                const blameInfo = blame.get(editor.selection.active.line + 1);
                if (!blameInfo) {
                    vscode.window.showWarningMessage('GitViz: No blame info for current line.');
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

        vscode.commands.registerCommand('gitviz.revealCommit', async (sha?: string) => {
            if (!sha) { return; }
            // Focus the Commits view panel, then filter to this SHA
            await vscode.commands.executeCommand(`${CommitsView.viewType}.focus`);
            commitsView.setFilter(sha.slice(0, 7));
        }),

        // ---------------------------------------------------------------------
        // Phase 2 — File / Line History commands
        // ---------------------------------------------------------------------

        vscode.commands.registerCommand('gitviz.openLineHistory', async () => {
            await vscode.commands.executeCommand('gitviz.lineHistory.focus');
        }),

        vscode.commands.registerCommand('gitviz.lineHistory.openDiff', async (sha: string) => {
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

        vscode.commands.registerCommand('gitviz.fileHistory.openAtRevision', async (entry: FileHistoryEntry) => {
            const filePath = fileHistoryProvider.getCurrentFilePath();
            if (!filePath) { return; }
            const uri = makeRevisionUri(gitService.getRepoRoot(), entry.sha, filePath);
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, { preview: true });
        }),

        vscode.commands.registerCommand('gitviz.fileHistory.diffWithPrevious', async (entry: FileHistoryEntry) => {
            const filePath = fileHistoryProvider.getCurrentFilePath();
            if (!filePath) { return; }
            const repoRoot = gitService.getRepoRoot();
            const prevUri = makeRevisionUri(repoRoot, `${entry.sha}~1`, filePath);
            const currUri = makeRevisionUri(repoRoot, entry.sha, filePath);
            const title = `${path.basename(filePath)} (${entry.sha.slice(0, 7)}^ ↔ ${entry.sha.slice(0, 7)})`;
            await vscode.commands.executeCommand('vscode.diff', prevUri, currUri, title);
        }),

        vscode.commands.registerCommand('gitviz.fileHistory.openCommitDetails', async (entry: string | FileHistoryEntry) => {
            const sha = typeof entry === 'string' ? entry : entry.sha;
            const highlightPath = fileHistoryProvider.getCurrentFilePath();
            await commitDetailsPanel.show(sha, highlightPath).catch((err: Error) => {
                vscode.window.showErrorMessage(`GitViz: ${err.message}`);
            });
        }),

        vscode.commands.registerCommand('gitviz.hotFiles.set7',   () => { hotFilesView.setTimeframe(7);    }),
        vscode.commands.registerCommand('gitviz.hotFiles.set30',  () => { hotFilesView.setTimeframe(30);   }),
        vscode.commands.registerCommand('gitviz.hotFiles.set90',  () => { hotFilesView.setTimeframe(90);   }),
        vscode.commands.registerCommand('gitviz.hotFiles.setAll', () => { hotFilesView.setTimeframe(null); }),
        vscode.commands.registerCommand('gitviz.hotFiles.hideDeleted', () => {
            hotFilesView.setHideDeleted(true);
            void vscode.commands.executeCommand('setContext', 'gitviz.hotFiles.hideDeleted', true);
        }),
        vscode.commands.registerCommand('gitviz.hotFiles.showDeleted', () => {
            hotFilesView.setHideDeleted(false);
            void vscode.commands.executeCommand('setContext', 'gitviz.hotFiles.hideDeleted', false);
        }),

        vscode.commands.registerCommand('gitviz.hotFiles.openFileHistory', async (entry: HotFileEntry) => {
            const absPath = path.join(gitService.getRepoRoot(), entry.path);
            fileHistoryProvider.loadForFile(absPath);
            await vscode.commands.executeCommand('gitviz.fileHistory.focus');
        }),

        // ---------------------------------------------------------------------
        // Phase 3 — Commits view
        // ---------------------------------------------------------------------

        // ---------------------------------------------------------------------
        // Phase 3 — Branches view
        // ---------------------------------------------------------------------

        vscode.commands.registerCommand('gitviz.branches.filterUntracked', () => {
            branchesProvider.setShowUntracked(true);
            void vscode.commands.executeCommand('setContext', 'gitviz.branches.showUntracked', true);
        }),

        vscode.commands.registerCommand('gitviz.branches.showAllBranches', () => {
            branchesProvider.setShowUntracked(false);
            void vscode.commands.executeCommand('setContext', 'gitviz.branches.showUntracked', false);
        }),

        vscode.commands.registerCommand('gitviz.branches.cleanupUntracked', async () => {
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
                        vscode.window.showErrorMessage(`GitViz: Failed to delete “${item.branch.name}”: ${(err as Error).message}`);
                    }
                }
            }
            void branchesProvider.refresh();
            if (!failed) {
                const n = selected.length;
                vscode.window.showInformationMessage(`Deleted ${n} branch${n !== 1 ? 'es' : ''}.`);
            }
        }),

        vscode.commands.registerCommand('gitviz.branch.checkout', async (node: { branch?: BranchInfo }) => {
            const name = node?.branch?.name ?? await vscode.window.showInputBox({
                title: 'Switch to Branch',
                placeHolder: 'Branch name',
            });
            if (!name) { return; }
            try {
                await gitService.checkoutBranch(name);
                void branchesProvider.refresh();
                void commitsView.refresh();
                vscode.window.showInformationMessage(`GitViz: Switched to branch "${name}".`);
            } catch (err) {
                vscode.window.showErrorMessage(`GitViz: ${(err as Error).message}`);
            }
        }),

        vscode.commands.registerCommand('gitviz.branch.create', () => {
            void vscode.commands.executeCommand('git.branch');
        }),

        vscode.commands.registerCommand('gitviz.branch.delete', () => {
            void vscode.commands.executeCommand('git.deleteBranch');
        }),

        vscode.commands.registerCommand('gitviz.branch.rename', () => {
            void vscode.commands.executeCommand('git.renameBranch');
        }),

        // ---------------------------------------------------------------------
        // Commits view — Tags filter
        // ---------------------------------------------------------------------

        vscode.commands.registerCommand('gitviz.commits.showTagsOnly', () => {
            void vscode.commands.executeCommand('setContext', 'gitviz.commits.tagsFilterActive', true);
            commitsView.showTagsOnly();
        }),

        vscode.commands.registerCommand('gitviz.commits.showAllCommits', () => {
            void vscode.commands.executeCommand('setContext', 'gitviz.commits.tagsFilterActive', false);
            commitsView.showAllCommits();
        }),

        // ---------------------------------------------------------------------
        // Phase 3 — Tags (create/delete via Commits view)
        // ---------------------------------------------------------------------

        vscode.commands.registerCommand('gitviz.tag.create', async () => {
            const tagName = await vscode.window.showInputBox({
                title: 'Create Tag',
                placeHolder: 'v1.0.0',
                validateInput: v => v.trim() ? undefined : 'Tag name cannot be empty',
            });
            if (!tagName) { return; }
            const annotation = await vscode.window.showInputBox({
                title: 'Tag Annotation (optional)',
                prompt: 'Leave empty to create a lightweight tag',
                placeHolder: 'e.g. Release v1.0.0',
            });
            if (annotation === undefined) { return; }
            try {
                await gitService.createTag(tagName.trim(), undefined, annotation.trim() || undefined);
                await commitsView.refresh();
                await commitsView.promptAndPushTag(tagName.trim());
            } catch (err) {
                vscode.window.showErrorMessage(`GitViz: ${(err as Error).message}`);
            }
        }),

        vscode.commands.registerCommand('gitviz.tag.delete', async () => {
            let tags: import('./git/types').TagInfo[];
            try {
                tags = await gitService.getTags();
            } catch {
                vscode.window.showErrorMessage('GitViz: Could not fetch tags.');
                return;
            }
            if (!tags.length) { vscode.window.showInformationMessage('No tags found.'); return; }
            const picked = await vscode.window.showQuickPick(
                tags.map(t => ({ label: t.name, description: t.sha.slice(0, 7) + (t.subject ? '  ' + t.subject : '') })),
                { title: 'Delete Tag', placeHolder: 'Select a tag to delete' }
            );
            if (!picked) { return; }
            const confirmed = await vscode.window.showWarningMessage(
                `Delete Tag "${picked.label}"? This cannot be undone.`, { modal: true }, 'Delete'
            );
            if (confirmed !== 'Delete') { return; }
            try {
                await gitService.deleteTag(picked.label);
                await commitsView.refresh();
                vscode.window.showInformationMessage(`GitViz: Tag "${picked.label}" deleted.`);
            } catch (err) {
                vscode.window.showErrorMessage(`GitViz: ${(err as Error).message}`);
            }
        }),

        // ---------------------------------------------------------------------
        // Phase 3 — Stashes view
        // ---------------------------------------------------------------------

        vscode.commands.registerCommand('gitviz.stash.create', async () => {
            await vscode.commands.executeCommand('git.stash');
            void stashesProvider.refresh();
        }),

        vscode.commands.registerCommand('gitviz.stash.dropAll', async () => {
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
                vscode.window.showErrorMessage(`GitViz: ${err.message}`);
            });
            void stashesProvider.refresh();
        }),

        vscode.commands.registerCommand('gitviz.stash.openDetails', async (node: StashInfo) => {
            if (!node?.ref) { return; }
            await commitDetailsPanel.show(node.ref).catch((err: Error) => {
                vscode.window.showErrorMessage(`GitViz: ${err.message}`);
            });
        }),

        vscode.commands.registerCommand('gitviz.stash.applyEntry', async (node: StashInfo) => {
            if (!node?.ref) { return; }
            try {
                await gitService.applyStash(node.ref);
                vscode.window.showInformationMessage(`GitViz: Applied stash "${node.message}"`);
            } catch (err: any) {
                vscode.window.showErrorMessage(`GitViz: ${err.message}`);
            }
            void stashesProvider.refresh();
        }),

        vscode.commands.registerCommand('gitviz.stash.popEntry', async (node: StashInfo) => {
            if (!node?.ref) { return; }
            try {
                await gitService.popStash(node.ref);
                vscode.window.showInformationMessage(`GitViz: Popped stash "${node.message}"`);
            } catch (err: any) {
                vscode.window.showErrorMessage(`GitViz: ${err.message}`);
            }
            void stashesProvider.refresh();
        }),

        vscode.commands.registerCommand('gitviz.stash.dropEntry', async (node: StashInfo) => {
            if (!node?.ref) { return; }
            try {
                await gitService.dropStash(node.ref);
            } catch (err: any) {
                vscode.window.showErrorMessage(`GitViz: ${err.message}`);
            }
            void stashesProvider.refresh();
        }),

        // ---------------------------------------------------------------------
        // Phase 3 — Compare view
        // ---------------------------------------------------------------------

        vscode.commands.registerCommand('gitviz.compare.run', async (ref1: string, ref2: string) => {
            await comparePanel.show(ref1, ref2).catch((err: Error) => {
                vscode.window.showErrorMessage(`GitViz: ${err.message}`);
            });
        }),

        // ---------------------------------------------------------------------
        // Phase 4 — Worktrees
        // ---------------------------------------------------------------------

        vscode.commands.registerCommand('gitviz.worktree.open', (node: WorktreeInfo) => {
            void vscode.commands.executeCommand(
                'vscode.openFolder',
                vscode.Uri.file(node.path),
                { forceNewWindow: true },
            );
        }),

        vscode.commands.registerCommand('gitviz.worktree.create', async () => {
            const branches = await gitService.getBranches();
            const NEW_BRANCH = '$(add) Create new branch…';
            const items: vscode.QuickPickItem[] = [
                { label: NEW_BRANCH, description: '' },
                ...branches.map(b => ({
                    label: b.name,
                    description: b.sha.slice(0, 7),
                    detail: b.subject,
                })),
            ];
            const picked = await vscode.window.showQuickPick(items, {
                title: 'Worktree: Select Branch',
                placeHolder: 'Choose an existing branch or create a new one…',
                matchOnDescription: true,
            });
            if (!picked) { return; }

            let branch: string;
            if (picked.label === NEW_BRANCH) {
                const newName = await vscode.window.showInputBox({
                    title: 'Worktree: New Branch Name',
                    placeHolder: 'e.g. feature/my-feature',
                    validateInput: v => v.trim() ? null : 'Branch name cannot be empty',
                });
                if (!newName) { return; }
                branch = newName.trim();
            } else {
                branch = picked.label;
            }

            const repoRoot = gitService.getRepoRoot();
            const safeName = branch.replace(/[\/\\:*?"<>|]/g, '-');
            const suggested = path.join(path.dirname(repoRoot), path.basename(repoRoot) + '-' + safeName);
            const dirPath = await vscode.window.showInputBox({
                title: 'Worktree: Directory Path',
                value: suggested,
                prompt: 'Path for the new worktree directory',
                validateInput: v => v.trim() ? null : 'Directory path cannot be empty',
            });
            if (!dirPath) { return; }

            const isNew = picked.label === NEW_BRANCH;
            try {
                await gitService.addWorktree(dirPath.trim(), branch, isNew);
                void worktreesProvider.refresh();
                vscode.window.showInformationMessage(`GitViz: Worktree “${branch}” created at ${dirPath.trim()}.`);
            } catch (err) {
                vscode.window.showErrorMessage(`GitViz: ${(err as Error).message}`);
            }
        }),

        vscode.commands.registerCommand('gitviz.worktree.delete', async (node: WorktreeInfo) => {
            if (!node?.path) { return; }
            const branchLabel = node.branch.replace(/^refs\/heads\//, '') || '(detached)';
            const isDirty = node.staged > 0 || node.unstaged > 0;
            const detail = isDirty
                ? `This worktree has uncommitted changes (+${node.staged} staged, ~${node.unstaged} unstaged). All uncommitted work will be lost.`
                : undefined;
            const answer = await vscode.window.showWarningMessage(
                `Delete worktree “${branchLabel}” at ${node.path}?`,
                { modal: true, detail },
                'Delete',
            );
            if (answer !== 'Delete') { return; }
            try {
                await gitService.removeWorktree(node.path, isDirty);
                void worktreesProvider.refresh();
            } catch (err) {
                vscode.window.showErrorMessage(`GitViz: ${(err as Error).message}`);
            }
        }),
    );
}

export function deactivate(): void {
    GitService.resetInstance();
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/** Placeholder provider shown in all tree views when no git repository is detected. */
class NoRepoProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }
    getChildren(): vscode.TreeItem[] {
        const item = new vscode.TreeItem('No Git repository detected');
        item.iconPath = new vscode.ThemeIcon('warning');
        return [item];
    }
}

async function promptForSha(): Promise<string | undefined> {
    return vscode.window.showInputBox({
        prompt: 'Enter a commit SHA to copy',
        placeHolder: 'e.g. abc1234',
        validateInput: (v) => /^[0-9a-fA-F]{4,40}$/.test(v) ? null : 'Enter a valid hex SHA',
    });
}
