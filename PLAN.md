# GitViz — Lightweight GitLens Alternative
## Project Plan

---

## Overview

**GitViz** is a VS Code extension that recreates the core developer-facing features of GitLens
without cloud sync, AI features, adware, or telemetry. It targets developers who want powerful
Git insight directly in their editor — annotations, history, repository exploration, and power
Git operations — all fast, local, and free.

**Tech stack:** TypeScript · VS Code Extension API · `simple-git` npm package · Native VS Code settings system

---

## Architecture

```
gitviz/
├── src/
│   ├── extension.ts              # Entry point: activate(), deactivate(), wire everything up
│   ├── git/
│   │   ├── GitService.ts         # Wraps simple-git; singleton; repo detection
│   │   ├── BlameCache.ts         # Per-file blame cache, invalidated on save
│   │   ├── CommitCache.ts        # LRU cache for commit detail lookups
│   │   └── types.ts              # Shared types: BlameInfo, CommitInfo, FileHistoryEntry, etc.
│   ├── annotations/
│   │   ├── InlineBlame.ts        # Current-line ghost text decoration
│   │   ├── LineHeatmap.ts        # Full-file line background color decorations
│   │   ├── CodeLensProvider.ts   # Above-function commit + author CodeLens
│   │   └── StatusBarBlame.ts     # Bottom status bar item
│   ├── hovers/
│   │   └── BlameHoverProvider.ts # Rich hover popup with diff and commit detail
│   ├── views/
│   │   ├── FileHistoryProvider.ts      # TreeDataProvider for file history
│   │   ├── LineHistoryProvider.ts      # TreeDataProvider for line/range history
│   │   ├── RepositoriesProvider.ts     # Root tree: branches, remotes, tags, stashes, contributors
│   │   ├── CommitsProvider.ts          # Current branch commits list
│   │   ├── BranchesProvider.ts         # Local + remote branches tree
│   │   ├── RemotesProvider.ts          # Remotes and their branches
│   │   ├── TagsProvider.ts             # Tags list
│   │   ├── StashesProvider.ts          # Stashes list with apply/drop actions
│   │   ├── ContributorsProvider.ts     # Contributors with commit counts
│   │   ├── SearchCompareProvider.ts    # Search commits; compare two refs
│   │   └── WorktreesProvider.ts        # Worktrees panel
│   ├── editors/
│   │   └── RebaseEditorProvider.ts     # CustomTextEditorProvider for git-rebase-todo
│   ├── commands/
│   │   ├── blameCommands.ts            # Toggle blame, open diff, copy SHA, etc.
│   │   ├── historyCommands.ts          # Open file history, line history
│   │   ├── revertCommand.ts            # Git revert with commit picker
│   │   ├── worktreeCommands.ts         # Create, open, delete worktrees
│   │   └── searchCommands.ts           # Commit search quick pick
│   ├── webviews/
│   │   ├── CommitGraphPanel.ts         # WebView host for commit graph (deferred)
│   │   └── CommitDetailsPanel.ts       # WebView for rich commit detail view
│   └── config/
│       └── Config.ts                   # Typed wrapper around vscode.workspace.getConfiguration()
├── package.json                        # Extension manifest, contributes, settings schema
├── tsconfig.json
└── README.md
```

---

## Phase 1 — Core Annotations
**Goal:** The "daily driver" features. Blame on every line, heatmap, CodeLens, status bar.

### Features
- **Current line inline blame** — ghost text at end of active line: `author · date · message`
  - Updates on cursor move (debounced 80ms to avoid flicker)
  - Clears on uncommitted/untracked lines gracefully
  - Configurable format string (e.g. `{author}, {date} · {message|50}`)
- **Hover blame details** — `vscode.HoverProvider` on the inline annotation
  - Shows: full commit message, author + email, absolute + relative date
  - Shows: condensed diff of that commit (via `git show --stat`)
  - Navigation buttons: "Open Commit Details", "Diff with Previous", "Copy SHA"
- **Line background heatmap** — full-file background color tint per line based on age
  - Color scale from configurable "hot" (recent) to "cold" (old) using `backgroundColor` + `isWholeLine`
  - Alpha-blended (hottest ~16% opacity, coldest ~4%) so text stays readable
  - Also paints the overview ruler for scrollbar visibility
  - Threshold configurable in days (e.g. age > 365 days = coolest color)
  - Renders on file open; refreshes on save

### VS Code APIs Used
- `window.onDidChangeTextEditorSelection` — cursor move events
- `window.createTextEditorDecorationType` — ghost text + gutter colors
- `languages.registerCodeLensProvider` — CodeLens
- `languages.registerHoverProvider` — hover popup
- `window.createStatusBarItem` — status bar

### Key Implementation Notes
- Run `git blame --porcelain -L {line},{line} {file}` for current-line; cache full file blame on first access
- Invalidate `BlameCache` on `workspace.onDidSaveTextDocument`
- Handle edge cases: new files, binary files, files outside a repo, lines not yet committed
- Debounce decoration updates to prevent flicker on fast cursor movement

---

## Phase 2 — File & Line History + Diffs
**Goal:** Navigate the history of any file or line without leaving the editor.

### Features
- **File History view** — sidebar `TreeDataProvider` showing all commits that touched the current file
  - Columns: short SHA, author, relative date, commit message
  - Updates when active editor changes
  - Context menu: Diff with previous, Open at revision, Copy SHA
- **Line History view** — sidebar `TreeDataProvider` for a selected line range
  - Triggered via command or selection context menu
  - Shows all commits that last changed any line in the selection
- **Open Previous Revision** — open a read-only virtual document of the file at any prior commit
  - Uses `vscode.workspace.registerTextDocumentContentProvider` with a `gitviz:` URI scheme
  - Allows "compare with current" using VS Code's built-in diff editor
- **Diff with Previous** — one-click command to show `git diff {commit}^..{commit} -- {file}` in VS Code diff editor
  - Available from: status bar click, hover popup buttons, history view context menu
- **Show Commit Details panel** — `WebviewPanel` showing:
  - Commit metadata (full hash, author, date, message)
  - List of changed files with +/- stats
  - Click any file to open diff for that file at that commit
- **Hot Files view** — sidebar `TreeDataProvider` showing the most frequently edited files
  - Timeframe picker (view title bar button): Last 7 days / Last 30 days / Last 90 days / All time
  - Optional commit range mode: compare between two refs via `gitviz.setHotFilesRange` command
  - Each item shows: relative file path, commit count badge, top contributor name
  - Click → opens the file; context menu → Open File History
  - New `GitService.getHotFiles(since: Date | null): Promise<{path: string, count: number}[]>`
  - Implementation: `git log --name-only --format="" [--after="{date}"]` → frequency map, sorted descending, capped at 50 entries (configurable)

### VS Code APIs Used
- `window.registerTreeDataProvider` — file/line history sidebar + Hot Files panel
- `workspace.registerTextDocumentContentProvider` — virtual "file at commit X" documents
- `commands.executeCommand('vscode.diff', ...)` — open VS Code diff editor
- `window.createWebviewPanel` — commit details panel

### Key Implementation Notes
- `git log --follow --format="%H|%an|%ae|%ar|%s" -- {file}` for file history
- `git log -L {start},{end}:{file}` for line history (this can be slow on large repos — add a timeout)
- Virtual documents are keyed by `gitviz:{repo}?{sha}:{filepath}` URI
- Cache commit details in `CommitCache` (LRU, cap at 200 entries)

---

## Phase 3 — Sidebar Repository Views
**Goal:** A rich, explorable view of the entire repository from the sidebar.

### Activity Bar Container
A single "GitViz" activity bar icon housing multiple `TreeView` panels:

| View | Description |
|------|-------------|
| **Repositories** | Root view: branches, remotes, tags, stashes, contributors sub-trees |
| **Commits** | Commits on current branch with filtering |
| **Branches** | Local branches + remote tracking branches; switch, create, delete, rename |
| **Remotes** | Configured remotes and their branches; fetch |
| **Tags** | All tags; create, delete, push to remote |
| **Stashes** | All stashes; apply, pop, drop, show diff |
| **Contributors** | All contributors + commit count; click to filter commits by author |
| **Search & Compare** | Commit search by message/author/SHA/file; compare two refs |
| **Worktrees** | See Phase 4 |

### Per-View Implementation Notes

**Branches view:**
- `git branch -vv --format=...` for local branches with tracking info (ahead/behind counts)
- `git branch -r` for remote branches
- Context menu: Switch, Create from here, Rename, Delete, Push, Pull, Merge into current, Rebase onto

**Stashes view:**
- `git stash list --format="%gd|%s|%cr"` to list
- Context menu: Apply, Pop, Drop, Show diff (opens diff editor), Create branch from stash

**Search & Compare:**
- Search input triggers `git log --all --grep="{query}"` (message), `--author="{query}"`, `-S "{query}"` (content)
- Compare: pick two refs (branch/tag/SHA via quick pick), show `git log A..B` between them + overall diff stats

### VS Code APIs Used
- `window.registerTreeDataProvider` / `window.createTreeView` for each panel
- `TreeItem` with `contextValue` to drive context menu contributions
- `window.showQuickPick`, `window.showInputBox` for branch/tag operations

---

## Phase 4 — Power Features
**Goal:** The high-leverage Git power tools.

### 4a. Interactive Rebase Editor
**Implementation:** `CustomTextEditorProvider` that intercepts `git-rebase-todo` files.

- VS Code calls the custom editor whenever Git opens the rebase todo file
- Renders a drag-and-drop list of commits (WebView with vanilla JS, no framework needed)
- Each row: action dropdown (pick/squash/fixup/reword/drop/edit), short SHA, commit message
- Drag handle to reorder rows
- "Start Rebase" button writes the modified `git-rebase-todo` back to disk and saves
- Supports `--rebase-merges`: renders merge commit entries distinctly
- Falls back gracefully to text editor if parsing fails

**VS Code APIs Used:**
- `window.registerCustomEditorProvider` with `customEditor` contribution in `package.json`
- `WebviewPanel` inside the custom editor for the drag-and-drop UI

### 4b. Commit Graph (Deferred)
Deferred — approach (D3.js WebView vs canvas-rendered DAG vs simple tree) to be decided separately. Placeholder `CommitGraphPanel.ts` created but not wired.

### 4c. Worktrees
- **Worktrees panel** — sidebar `TreeDataProvider` listing all worktrees
  - Shows: path, branch, clean/dirty state
  - Context menu: Open in new window, Open in new VS Code workspace, Delete
- **Create worktree** — command palette: pick branch or enter new branch name, pick directory
- **Delete worktree** — with safety check (warn if dirty)
- **Open worktree** — `vscode.openFolder` in new window or same window (user choice)

**VS Code APIs Used:**
- `git worktree list --porcelain` for listing
- `git worktree add/remove` for create/delete
- `commands.executeCommand('vscode.openFolder', ...)` for opening

### 4d. Revert Command
- Command palette: "GitViz: Revert Commit"
- Shows quick pick of recent commits (last 50 on current branch)
- Runs `git revert {sha} --no-edit`; surfaces errors in notification

---

## Phase 5 — Settings & Polish

### Settings (all under `gitviz.*` namespace, native VS Code settings UI)

**Annotations**
| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `gitviz.blame.enabled` | boolean | true | Enable/disable all inline blame |
| `gitviz.blame.format` | string | `{author}, {date} · {message\|60}` | Inline blame format string |
| `gitviz.blame.dateFormat` | enum | `relative` | `relative`, `absolute`, `iso` |
| `gitviz.blame.highlightLine` | boolean | false | Highlight current line's age in gutter |
| `gitviz.heatmap.enabled` | boolean | true | Enable line heatmap |
| `gitviz.heatmap.hotColor` | string | `#ff6600` | Color for most-recent changes |
| `gitviz.heatmap.coldColor` | string | `#0066ff` | Color for oldest changes |
| `gitviz.heatmap.ageThresholdDays` | number | 365 | Days before hitting coldest color |

**CodeLens**
| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `gitviz.codelens.enabled` | boolean | true | Enable/disable CodeLens |
| `gitviz.codelens.scopes` | array | `["functions","classes"]` | Where to show: `files`, `classes`, `functions`, `blocks` |
| `gitviz.codelens.showAuthors` | boolean | true | Show "N authors" CodeLens |

**Status Bar**
| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `gitviz.statusBar.enabled` | boolean | true | Show blame in status bar |
| `gitviz.statusBar.format` | string | `{author}, {date}` | Status bar format string |
| `gitviz.statusBar.clickBehavior` | enum | `openDetails` | `openDetails`, `copySha`, `openDiff` |

**Views**
| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `gitviz.views.defaultLocation` | enum | `gitviz` | `gitviz` (own panel) or `scm` (Source Control panel) |

**Per-workspace settings:** All settings support workspace-level override via `.vscode/settings.json` automatically (standard VS Code behavior with `contributes.configuration`).

### Polish Items
- Loading states in tree views (show spinner while git commands run)
- Graceful degradation when not in a git repo (hide all UI, show "No repo detected")
- Error surfaces: git command failures shown as VS Code notifications with details
- Telemetry: **none**. No tracking, no analytics, no network calls.
- Performance: all git calls go through a command queue with a concurrency limit of 3
- Large repo guard: warn + cap history views at configurable limit (default 1000 commits)
- Binary file guard: skip blame/heatmap for detected binary files

---

## Dependency List

| Package | Purpose |
|---------|---------|
| `simple-git` | Typed async wrapper around git CLI |
| `@types/vscode` | VS Code extension type definitions |
| `typescript` | Language |
| `esbuild` | Fast bundler for extension output |
| `@vscode/test-electron` | Extension integration testing |

No UI frameworks (React, Vue, etc.) — WebViews use vanilla JS/HTML to keep the bundle tiny.

---

## Testing Strategy

- **Unit tests:** `BlameCache`, `CommitCache`, git output parsers — pure functions, easy to test
- **Integration tests:** Full extension activation, command execution against a fixture git repo (checked in under `test/fixtures/`)
- **Manual test checklist** per phase before tagging a release

---

## Build & Release

```bash
npm install
npm run compile        # tsc + esbuild
npm run package        # vsce package → .vsix
code --install-extension gitviz-{version}.vsix
```

Releases distributed as `.vsix` files (sideload) or via Open VSX Registry. No Microsoft Marketplace dependency required.
