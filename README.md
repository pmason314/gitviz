# GitLite

A fast, lightweight, and completely free VS Code extension that brings powerful Git annotations, useful visualizations, and easy repository exploration to your editor — without forced account linking, AI integration, or telemetry.  Heavily inspired by [GitLens](https://marketplace.visualstudio.com/items?itemName=eamodio.gitlens).

## Features

### Editor Annotations

- **Inline blame** — ghost text at the end of the active line showing author, relative date, and commit message, configurable via a format string
- **Hover details** — rich popup over any blamed line with full commit info, diff stats, and action buttons (open diff, copy SHA, reveal in Commits view)
- **Line heatmap** — color-coded line backgrounds showing the relative age of every line in the file, from hot (recent) to cold (old)

### Sidebar Views (GitLite activity bar panel)

- **File History** — full commit history for the currently open file, with tags highlighted in tooltips; opens diff or commit details on click
- **Line History** — commit history scoped to the selected line range, updating live as you move the cursor
- **Hot Files** — most frequently changed files ranked by commit count, filterable by timeframe (7d / 30d / 90d / all time) and by glob pattern
- **Commits** — searchable, filterable list of all commits on the current branch; filter by message, SHA, or `@author`; open commits in a visual graph or create/delete tags directly from the panel
- **Compare** — diff any two refs (branches, tags, SHAs) side-by-side with per-file change stats
- **Branches** — local and remote branches with ahead/behind counts; checkout, create, rename, delete, and prune branches without leaving VS Code
- **Stashes** — view, apply, pop, and drop stashes
- **Worktrees** — list and open linked worktrees; create and delete directly from the panel

### Full-Panel Views

- **Commit Graph** — canvas-rendered DAG showing the full branch history with ref badges (branches, tags, HEAD, remotes); supports checkout, create branch, cherry-pick, and soft/mixed/hard reset from a right-click menu
- **Commit Details** — rich panel showing message, author, date, full SHA, and per-file change breakdown with inline diff access; opens from any history view or the Commits sidebar

### Git Workflow Integration

- **Interactive Rebase editor** — replaces the plain-text `git-rebase-todo` editor with a drag-and-drop UI; supports pick, reword, edit, squash, fixup, and drop with keyboard shortcuts and live squash message preview

## Requirements

- VS Code 1.85+
- Git installed and available on `PATH`

## Settings

All settings are under the `gitlite.*` namespace and configurable via **Settings** (`Ctrl+,`).

| Setting | Default | Description |
|---------|---------|-------------|
| `gitlite.blame.enabled` | `true` | Enable inline blame annotations |
| `gitlite.blame.format` | `{author}, {date} · {message\|60}` | Format string; tokens: `{author}`, `{authorEmail}`, `{date}`, `{sha}`, `{message\|N}` |
| `gitlite.blame.dateFormat` | `relative` | `relative`, `absolute`, or `iso` |
| `gitlite.blame.maxLines` | `10000` | Skip blame for files over this many lines |
| `gitlite.blame.maxFileSizeKb` | `1024` | Skip blame for files over this size (KB) |
| `gitlite.heatmap.enabled` | `false` | Enable line heatmap |
| `gitlite.heatmap.hotColor` | `#ff6600` | Color for recently changed lines |
| `gitlite.heatmap.coldColor` | `#0066ff` | Color for old lines |
| `gitlite.heatmap.ageThresholdDays` | `365` | Days until a line reaches the coldest color in the line heatmap |
| `gitlite.history.maxCommits` | `500` | Max commits shown in File/Line History |

## Commands

| Command | Description |
|---------|-------------|
| `GitLite: Toggle Inline Blame` | Show/hide inline blame annotations |
| `GitLite: Toggle Line Heatmap` | Show/hide the line heatmap |
| `GitLite: Open Commit Graph` | Open the Commit Graph panel |
| `GitLite: Open Commit Details` | Open the Commit Details panel for a SHA |
| `GitLite: Show Line History` | Open Line History for the current selection |
| `GitLite: Compare Refs` | Open the Compare view |
| `GitLite: Start Interactive Rebase` | Begin an interactive rebase |
| `GitLite: Revert Commit` | Revert a commit |
| `GitLite: Create Tag` | Create a tag at a commit |

## Building from Source

```bash
npm install
npm run compile
```

Press **F5** to launch the extension in a new Extension Development Host window.

## License

GPL v3
