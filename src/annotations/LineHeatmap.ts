import * as vscode from 'vscode';
import { Config } from '../config/Config';
import { GitService } from '../git/GitService';
import { isBinaryFile } from '../utils/fileUtils';

const NUM_BUCKETS = 10;

/**
 * Colors the background of each line in the active file based on how recently
 * it was changed. Hotter colors = more recently changed; cooler = older.
 *
 * Performance contract:
 *   - Reuses blame data already held by BlameCache — zero additional git calls.
 *   - Pre-creates NUM_BUCKETS TextEditorDecorationType objects at construction.
 *   - One O(N) pass groups lines into buckets; then NUM_BUCKETS setDecorations calls total.
 *   - Background uses alpha-blended color so text stays readable.
 */
export class LineHeatmap implements vscode.Disposable {
    private readonly decorationTypes: vscode.TextEditorDecorationType[] = [];
    private readonly disposables: vscode.Disposable[] = [];
    private enabled: boolean;

    constructor(
        private readonly gitService: GitService,
        private readonly config: Config
    ) {
        this.enabled = config.heatmapEnabled();
        this.decorationTypes = this.buildDecorationTypes();

        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                if (editor) { this.renderEditor(editor); }
            }),
            config.onDidChange(() => {
                this.enabled = config.heatmapEnabled();
                // Rebuild decoration types (colors may have changed)
                this.clearAllDecorationTypes();
                this.decorationTypes.length = 0;
                this.buildDecorationTypes().forEach((dt) => this.decorationTypes.push(dt));

                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    if (this.enabled) {
                        this.renderEditor(editor);
                    } else {
                        this.clearEditor(editor);
                    }
                }
            })
        );

        // Render for the already-active editor on startup
        if (vscode.window.activeTextEditor) {
            this.renderEditor(vscode.window.activeTextEditor);
        }
    }

    toggle(): void {
        this.enabled = !this.enabled;
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return; }
        if (this.enabled) {
            this.renderEditor(editor);
        } else {
            this.clearEditor(editor);
        }
    }

    /** Called on save — re-render after cache has been invalidated. */
    onFileSaved(document: vscode.TextDocument): void {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document === document) {
            this.renderEditor(editor);
        }
    }

    dispose(): void {
        this.clearAllDecorationTypes();
        this.disposables.forEach((d) => d.dispose());
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    private async renderEditor(editor: vscode.TextEditor): Promise<void> {
        if (!this.enabled) { return; }

        const document = editor.document;
        if (document.uri.scheme !== 'file') { return; }

        if (document.lineCount > this.config.blameMaxLines()) {
            this.clearEditor(editor);
            return;
        }

        if (await isBinaryFile(document.uri.fsPath)) {
            this.clearEditor(editor);
            return;
        }

        let blameMap: Awaited<ReturnType<GitService['getBlameForFile']>>;
        try {
            blameMap = await this.gitService.getBlameForFile(document.uri.fsPath);
        } catch {
            this.clearEditor(editor);
            return;
        }

        const now = Date.now();
        const thresholdMs = this.config.heatmapThresholdDays() * 24 * 60 * 60 * 1000;

        // Group 0-indexed line numbers into buckets by age
        const buckets: vscode.Range[][] = Array.from({ length: NUM_BUCKETS }, () => []);

        blameMap.forEach((info, lineNumber) => {
            const ageMs = now - info.authorDate.getTime();
            const ratio = Math.min(ageMs / thresholdMs, 1); // 0 = hot, 1 = cold
            const bucketIndex = Math.min(Math.floor(ratio * NUM_BUCKETS), NUM_BUCKETS - 1);
            const vscodeLine = lineNumber - 1; // convert 1-indexed to 0-indexed
            if (vscodeLine >= 0 && vscodeLine < document.lineCount) {
                buckets[bucketIndex].push(new vscode.Range(vscodeLine, 0, vscodeLine, 0));
            }
        });

        // Apply all buckets in one pass
        this.decorationTypes.forEach((dt, i) => {
            editor.setDecorations(dt, buckets[i]);
        });
    }

    private clearEditor(editor: vscode.TextEditor): void {
        this.decorationTypes.forEach((dt) => editor.setDecorations(dt, []));
    }

    private clearAllDecorationTypes(): void {
        this.decorationTypes.forEach((dt) => dt.dispose());
    }

    /**
     * Pre-create NUM_BUCKETS decoration types, one per age bucket.
     * Bucket 0 = hottest (most recent), bucket NUM_BUCKETS-1 = coldest (oldest).
     * Alpha: hottest = 0x28 (~16% opacity), coldest = 0x0a (~4%) — text remains readable.
     */
    private buildDecorationTypes(): vscode.TextEditorDecorationType[] {
        const hot = parseHex(this.config.heatmapHot());
        const cold = parseHex(this.config.heatmapCold());
        const types: vscode.TextEditorDecorationType[] = [];

        for (let i = 0; i < NUM_BUCKETS; i++) {
            const ratio = i / (NUM_BUCKETS - 1); // 0 = hot, 1 = cold
            const color = lerpColor(hot, cold, ratio);
            const alpha = Math.round(0x28 - ratio * 0x1e).toString(16).padStart(2, '0');
            types.push(
                vscode.window.createTextEditorDecorationType({
                    backgroundColor: `${color}${alpha}`,
                    isWholeLine: true,
                    overviewRulerColor: color,
                    overviewRulerLane: vscode.OverviewRulerLane.Left,
                })
            );
        }

        return types;
    }
}

// -------------------------------------------------------------------------
// Binary file detection
// -------------------------------------------------------------------------

// -------------------------------------------------------------------------
// Color helpers
// -------------------------------------------------------------------------

type RGB = [number, number, number];

function parseHex(hex: string): RGB {
    const clean = hex.replace(/^#/, '');
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return [
        isNaN(r) ? 0 : r,
        isNaN(g) ? 0 : g,
        isNaN(b) ? 0 : b,
    ];
}

function lerpColor(a: RGB, b: RGB, t: number): string {
    const r = Math.round(a[0] + (b[0] - a[0]) * t);
    const g = Math.round(a[1] + (b[1] - a[1]) * t);
    const bl = Math.round(a[2] + (b[2] - a[2]) * t);
    return `#${toHex(r)}${toHex(g)}${toHex(bl)}`;
}

function toHex(n: number): string {
    return Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
}
