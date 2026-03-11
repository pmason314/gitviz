# GitLite

A lightweight, fast VS Code extension that brings powerful Git annotations and repository exploration to your editor — without cloud sync, AI upsells, or telemetry.

## Features (Phase 1)

- **Inline blame** — ghost text at the end of the active line showing author, date, and commit message
- **Hover details** — rich popup with full commit info, diff stats, and action buttons
- **Line heatmap** — color-coded line backgrounds showing the relative age of every line in the file
- **CodeLens** — above-function blame summary showing the most recent commit and author count
- **Status bar** — current-line blame in the status bar with configurable click behavior

## Requirements

- VS Code 1.85+
- Git installed and available on `PATH`

## Settings

All settings are under the `gitlite.*` namespace and configurable via the standard VS Code settings UI.

| Setting | Default | Description |
|---------|---------|-------------|
| `gitlite.blame.enabled` | `true` | Enable inline blame |
| `gitlite.blame.format` | `{author}, {date} · {message\|60}` | Blame format string |
| `gitlite.blame.dateFormat` | `relative` | `relative`, `absolute`, or `iso` |
| `gitlite.blame.maxLines` | `10000` | Skip blame for files over this many lines |
| `gitlite.heatmap.enabled` | `true` | Enable line heatmap |
| `gitlite.heatmap.hotColor` | `#ff6600` | Color for recently changed lines |
| `gitlite.heatmap.coldColor` | `#0066ff` | Color for old lines |
| `gitlite.heatmap.ageThresholdDays` | `365` | Days until a line is "cold" |
| `gitlite.codelens.enabled` | `true` | Enable CodeLens |
| `gitlite.codelens.scopes` | `["functions","classes"]` | Where to show CodeLens |
| `gitlite.statusBar.enabled` | `true` | Show blame in status bar |
| `gitlite.statusBar.clickBehavior` | `openDetails` | `openDetails`, `copySha`, or `openDiff` |

## Commands

| Command | Description |
|---------|-------------|
| `GitLite: Toggle Inline Blame` | Show/hide inline blame annotations |
| `GitLite: Toggle Line Heatmap` | Show/hide the line heatmap |

## Building from Source

```bash
npm install
npm run compile
```

Press **F5** to launch the extension in a new Extension Development Host window.

## License

MIT
