import * as vscode from 'vscode';

export type DateFormat = 'relative' | 'absolute' | 'iso';

/**
 * Typed wrapper around vscode.workspace.getConfiguration('gitviz').
 * All consuming code accesses settings through named accessors here so that
 * key strings are never scattered through the codebase.
 */
export class Config {
    private get<T>(key: string, fallback: T): T {
        return vscode.workspace.getConfiguration('gitviz').get<T>(key) ?? fallback;
    }

    // Blame
    blameEnabled(): boolean { return this.get('blame.enabled', true); }
    blameFormat(): string { return this.get('blame.format', '{author}, {date} · {message|60}'); }
    blameDate(): DateFormat { return this.get('blame.dateFormat', 'relative'); }
    blameHighlightLine(): boolean { return this.get('blame.highlightLine', false); }
    blameMaxLines(): number { return this.get('blame.maxLines', 10000); }
    blameMaxFileSizeKb(): number { return this.get('blame.maxFileSizeKb', 1024); }

    // Heatmap
    heatmapEnabled(): boolean { return this.get('heatmap.enabled', true); }
    heatmapHot(): string { return this.get('heatmap.hotColor', '#ff6600'); }
    heatmapCold(): string { return this.get('heatmap.coldColor', '#0066ff'); }
    heatmapThresholdDays(): number { return this.get('heatmap.ageThresholdDays', 365); }

    // History views
    historyMaxCommits(): number { return this.get('history.maxCommits', 500); }

    // Cache sizes
    blameCacheMaxFiles(): number { return this.get('cache.blameMaxFiles', 50); }
    commitCacheMaxEntries(): number { return this.get('cache.commitMaxEntries', 200); }

    /**
     * Subscribe to any gitviz.* configuration change.
     * Returns the disposable so callers can add it to their subscriptions.
     */
    onDidChange(handler: () => void): vscode.Disposable {
        return vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('gitviz')) {
                handler();
            }
        });
    }
}
