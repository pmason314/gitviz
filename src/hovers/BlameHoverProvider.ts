import * as vscode from 'vscode';
import { Config } from '../config/Config';
import { GitService } from '../git/GitService';
import { BlameInfo } from '../git/types';
import { relativeTime } from '../annotations/InlineBlame';


const UNCOMMITTED_SHA = '0000000000000000000000000000000000000000';

/**
 * Provides a rich hover popup over any line in a blamed file.
 * Shows: commit summary, author details, dates, diff stats, action buttons.
 *
 * isTrusted: true is required on the MarkdownString to enable command: URIs.
 */
export class BlameHoverProvider implements vscode.HoverProvider, vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly gitService: GitService,
        private readonly config: Config
    ) {}

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): Promise<vscode.Hover | null> {
        if (!this.config.blameEnabled()) { return null; }
        if (document.uri.scheme !== 'file') { return null; }
        if (document.lineCount > this.config.blameMaxLines()) { return null; }

        // Only show hover on the line that currently has the inline blame annotation
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.toString() !== document.uri.toString()) { return null; }
        if (position.line !== editor.selection.active.line) { return null; }

        const lineNumber = position.line + 1; // 1-indexed

        let blameMap: Map<number, BlameInfo>;
        try {
            blameMap = await this.gitService.getBlameForFile(document.uri.fsPath);
        } catch {
            return null;
        }

        const info = blameMap.get(lineNumber);
        if (!info) { return null; }

        if (info.sha === UNCOMMITTED_SHA) {
            const md = new vscode.MarkdownString('$(git-commit) **Not yet committed**');
            md.supportThemeIcons = true;
            return new vscode.Hover(md);
        }

        const md = await this.buildMarkdown(info, document.uri.fsPath, lineNumber);
        return new vscode.Hover(md);
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    private async buildMarkdown(info: BlameInfo, filePath: string, lineNumber: number): Promise<vscode.MarkdownString> {
        const currentUser = await this.gitService.getCurrentUser();
        const currentUserEmail = currentUser?.email ?? null;

        const copyShaArg = encodeURIComponent(JSON.stringify(info.sha));
        const openDetailsArg = encodeURIComponent(JSON.stringify(info.sha));
        const diffArg = encodeURIComponent(JSON.stringify({ sha: info.sha, filePath }));

        // Fetch Last Changed and First Introduced commits in parallel
        const [lastCommit, originCommit] = await Promise.allSettled([
            this.gitService.getCommit(info.sha),
            this.gitService.getLineOrigin(filePath, lineNumber),
        ]);
        const last = lastCommit.status === 'fulfilled' ? lastCommit.value : null;
        const origin = originCommit.status === 'fulfilled' ? originCommit.value : null;

        const fallback = { sha: info.sha, author: info.author, authorEmail: info.authorEmail, date: info.authorDate, message: info.summary, body: '', diffStats: '' };
        const lines: string[] = [];

        lines.push(...buildCommitSection('Last Changed', last ?? fallback, currentUserEmail));

        // Only show First Introduced if it's a different commit
        if (origin && origin.sha !== info.sha) {
            lines.push('---', '');
            lines.push(...buildCommitSection('First Introduced', origin, currentUserEmail));
        }

        lines.push(
            '---',
            '',
            `[$(clippy) Copy SHA](command:gitviz.copySha?${copyShaArg}) ` +
            `&nbsp; [$(eye) Show Commit Details](command:gitviz.openCommitDetails?${openDetailsArg}) ` +
            `&nbsp; [$(diff) Diff with Previous](command:gitviz.diffWithPrevious?${diffArg}) &nbsp;`
        );

        const md = new vscode.MarkdownString(lines.join('\n'), true);
        md.isTrusted = true;
        md.supportThemeIcons = true;
        return md;
    }
}

function escapeMd(text: string): string {
    return text.replace(/[\\`*_{}[\]()#+\-.!|]/g, '\\$&');
}

function buildCommitSection(
    heading: string,
    commit: { sha: string; author: string; authorEmail: string; date: Date; message: string; body: string; diffStats: string },
    currentUserEmail: string | null
): string[] {
    const fullMessage = commit.body ? `${commit.message}\n\n${commit.body}` : commit.message;
    const shortSha = commit.sha.slice(0, 7);
    const revealArg = encodeURIComponent(JSON.stringify(commit.sha));
    const isCurrentUser = currentUserEmail !== null &&
        currentUserEmail.toLowerCase() === commit.authorEmail.toLowerCase();
    const displayName = isCurrentUser ? 'You' : escapeMd(commit.author);
    const relDate = relativeTime(commit.date);
    const absDate = commit.date.toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
    const quotedMessage = fullMessage
        .split('\n')
        .map(l => l.trim() ? `> *${escapeMd(l)}*` : '>')
        .join('\n');
    const lines: string[] = [
        `**${heading}**`,
        '',
        `**${displayName}** $(history) ${relDate} *(${absDate})* via [${shortSha}](command:gitviz.revealCommit?${revealArg})`,
        '',
        quotedMessage,
        '',
    ];
    lines.push(...parseChangeCounts(commit.diffStats));
    return lines;
}


function parseChangeCounts(diffStats: string): string[] {
    const ins = diffStats.match(/(\d+) insertion/);
    const del = diffStats.match(/(\d+) deletion/);
    if (!ins && !del) { return []; }
    // A `diff` code fence is the only reliable way to get green/red in hover markdown —
    // VS Code strips inline styles and codicons render monochrome.
    const fenceLines = ['> ```diff'];
    if (ins) { fenceLines.push(`> + ${ins[1]} line${ins[1] === '1' ? '' : 's'} added`); }
    if (del) { fenceLines.push(`> - ${del[1]} line${del[1] === '1' ? '' : 's'} removed`); }
    fenceLines.push('> ```', '');
    return fenceLines;
}
