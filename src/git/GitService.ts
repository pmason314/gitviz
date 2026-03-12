import * as path from 'path';
import simpleGit, { SimpleGit } from 'simple-git';
import { BlameCache } from './BlameCache';
import { CommitCache } from './CommitCache';
import { BlameInfo, CommitInfo, FileHistoryEntry, CommitFileEntry, HotFileEntry } from './types';

const MAX_CONCURRENCY = 3;

/**
 * Singleton Git service. All git operations flow through here.
 *
 * Concurrency semaphore: at most MAX_CONCURRENCY git processes run simultaneously.
 * Additional callers queue and wait rather than spawning unbounded processes.
 *
 * Blame in-flight deduplication is handled by BlameCache.getOrFetch().
 */
export class GitService {
    private static instance: GitService | undefined;

    private readonly git: SimpleGit;
    private readonly blameCache: BlameCache;
    private readonly commitCache: CommitCache;

    /** Concurrency semaphore state */
    private running = 0;
    private readonly queue: Array<() => void> = [];

    private constructor(
        private readonly repoRoot: string,
        blameCache: BlameCache,
        commitCache: CommitCache
    ) {
        this.git = simpleGit(repoRoot);
        this.blameCache = blameCache;
        this.commitCache = commitCache;
    }

    static getInstance(repoRoot: string, blameCache: BlameCache, commitCache: CommitCache): GitService {
        if (!GitService.instance) {
            GitService.instance = new GitService(repoRoot, blameCache, commitCache);
        }
        return GitService.instance;
    }

    static resetInstance(): void {
        GitService.instance = undefined;
    }

    // -------------------------------------------------------------------------
    // Semaphore helpers
    // -------------------------------------------------------------------------

    private acquire(): Promise<void> {
        return new Promise((resolve) => {
            if (this.running < MAX_CONCURRENCY) {
                this.running++;
                resolve();
            } else {
                this.queue.push(() => {
                    this.running++;
                    resolve();
                });
            }
        });
    }

    private release(): void {
        this.running--;
        const next = this.queue.shift();
        if (next) {
            next();
        }
    }

    private async run<T>(fn: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await fn();
        } finally {
            this.release();
        }
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Detect the git repository root for a given path.
     * Accepts either a directory path or a file path.
     * Returns null if the path is not inside a git repo.
     */
    static async findRepoRoot(fsPath: string): Promise<string | null> {
        // Try the path directly first (handles workspace folder directory paths),
        // then its dirname (handles file paths). Using a Set deduplicates the
        // common case where fsPath is already a directory root.
        const candidates = [fsPath, path.dirname(fsPath)];
        for (const dir of [...new Set(candidates)]) {
            try {
                const git = simpleGit(dir);
                const root = await git.revparse(['--show-toplevel']);
                return root.trim();
            } catch {
                // try next candidate
            }
        }
        return null;
    }

    getRepoRoot(): string {
        return this.repoRoot;
    }

    /**
     * Return blame data for an entire file.
     * Results are memoized in BlameCache; concurrent callers share one git process.
     */
    async getBlameForFile(filePath: string): Promise<Map<number, BlameInfo>> {
        return this.blameCache.getOrFetch(filePath, () =>
            this.run(() => this.fetchBlame(filePath))
        );
    }

    /**
     * Return commit details, using CommitCache to avoid repeated git show calls.
     */
    async getCommit(sha: string): Promise<CommitInfo> {
        const cached = this.commitCache.get(sha);
        if (cached) {
            return cached;
        }
        return this.run(async () => {
            const info = await this.fetchCommit(sha);
            this.commitCache.set(sha, info);
            return info;
        });
    }

    /**
     * Return the commit history for a file, following renames.
     */
    async getFileHistory(filePath: string): Promise<FileHistoryEntry[]> {
        return this.run(() => this.fetchFileHistory(filePath));
    }

    /**
     * Return the oldest commit that introduced the given line in a file by tracing
     * full line history with `git log -L`. Returns null if the line can't be traced.
     */
    async getLineOrigin(filePath: string, lineNumber: number): Promise<CommitInfo | null> {
        const relativePath = path.relative(this.repoRoot, filePath);
        let output: string;
        try {
            output = await this.run(() => this.git.raw([
                'log',
                '--format=%H',
                '--no-patch',
                `-L${lineNumber},${lineNumber}:${relativePath}`,
            ]));
        } catch {
            return null;
        }
        // Extract only 40-char hex SHA lines; any diff noise is ignored.
        const shas = output.split('\n')
            .map(l => l.trim())
            .filter(l => /^[0-9a-f]{40}$/i.test(l));
        if (shas.length === 0) { return null; }
        // Last SHA is the oldest commit (first time this line existed).
        return this.getCommit(shas[shas.length - 1]);
    }

    /**
     * Return the current git user's name and email from local/global config.
     * Result is cached for the lifetime of the instance (git config rarely changes).
     */
    private currentUserPromise: Promise<{ name: string; email: string } | null> | undefined;
    getCurrentUser(): Promise<{ name: string; email: string } | null> {
        if (!this.currentUserPromise) {
            this.currentUserPromise = (async () => {
                try {
                    const name = (await this.git.raw(['config', 'user.name'])).trim();
                    const email = (await this.git.raw(['config', 'user.email'])).trim();
                    return { name, email };
                } catch {
                    return null;
                }
            })();
        }
        return this.currentUserPromise;
    }

    // -------------------------------------------------------------------------
    // Private fetch methods (raw git calls)
    // -------------------------------------------------------------------------

    private async fetchBlame(filePath: string): Promise<Map<number, BlameInfo>> {
        // Use raw git rather than simple-git's blame wrapper to get --porcelain output
        const relativePath = path.relative(this.repoRoot, filePath);
        const output = await this.git.raw(['blame', '--porcelain', relativePath]);
        return parsePorcelainBlame(output);
    }

    private async fetchCommit(sha: string): Promise<CommitInfo> {
        // Use ASCII Unit Separator (0x1f) — safe in C strings (unlike NUL which
        // terminates git's argument parser), and never appears in commit messages.
        const SEP = '\x1f';
        const formatStr = `%H${SEP}%an${SEP}%ae${SEP}%aI${SEP}%s${SEP}%b`;
        // git log -1 with --stat naturally omits patch content (unlike git show).
        const output = await this.git.raw([
            'log',
            '-1',
            `--format=${formatStr}`,
            '--stat',
            sha,
        ]);

        const lines = output.split('\n');
        // First line is the formatted metadata
        const metaLine = lines[0];
        const parts = metaLine.split(SEP);
        if (parts.length < 6) {
            throw new Error(`Unexpected git log output for ${sha}: ${JSON.stringify(metaLine.slice(0, 80))}`);
        }
        const [fullSha, author, authorEmail, dateIso, message, ...bodyParts] = parts;
        const body = bodyParts.join(SEP).trim();

        // Everything after the blank line following the format is the --stat block
        const statStart = lines.findIndex((l) => l.startsWith(' '));
        const diffStats = statStart >= 0 ? lines.slice(statStart).join('\n').trim() : '';

        return {
            sha: fullSha.trim(),
            author: author.trim(),
            authorEmail: authorEmail.trim(),
            date: new Date(dateIso.trim()),
            message: message.trim(),
            body,
            diffStats,
        };
    }

    /**
     * Return the raw content of a file at a given git revision.
     * @param relativePath Path relative to the repo root.
     * @param sha Any git revision: SHA, HEAD~1, branch name, etc.
     */
    async getFileAtRevision(relativePath: string, sha: string): Promise<string> {
        return this.run(() => this.git.show([`${sha}:${relativePath}`]));
    }

    /** Return the files changed in a commit with insertion/deletion line counts. */
    async getCommitFiles(sha: string): Promise<CommitFileEntry[]> {
        return this.run(() => this.fetchCommitFiles(sha));
    }

    /**
     * Return commits that touched a line range in a file (uses `git log -L`).
     * Capped at 10 seconds to avoid blocking on large histories.
     */
    async getLineHistory(filePath: string, startLine: number, endLine: number): Promise<FileHistoryEntry[]> {
        const TIMEOUT_MS = 10_000;
        return Promise.race([
            this.run(() => this.fetchLineHistory(filePath, startLine, endLine)),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Line history timed out after 10s')), TIMEOUT_MS)
            ),
        ]);
    }

    /**
     * Return files sorted by commit frequency since the given date (or all time).
     * Capped at 50 entries.
     */
    async getHotFiles(since: Date | null): Promise<HotFileEntry[]> {
        return this.run(() => this.fetchHotFiles(since));
    }

    private async fetchFileHistory(filePath: string): Promise<FileHistoryEntry[]> {
        const relativePath = path.relative(this.repoRoot, filePath);
        const output = await this.git.raw([
            'log',
            '--follow',
            '--format=%H\x1f%an\x1f%ae\x1f%aI\x1f%ar\x1f%s',
            '--',
            relativePath,
        ]);

        if (!output.trim()) {
            return [];
        }

        return output
            .trim()
            .split('\n')
            .map((line) => {
                const [sha, author, authorEmail, dateIso, relativeDate, message] = line.split('\x1f');
                return {
                    sha: sha.trim(),
                    author: author.trim(),
                    authorEmail: authorEmail.trim(),
                    date: new Date(dateIso.trim()),
                    relativeDate: relativeDate.trim(),
                    message: message.trim(),
                };
            });
    }

    private async fetchCommitFiles(sha: string): Promise<CommitFileEntry[]> {
        // diff-tree --numstat: insertions \t deletions \t path
        // Binary files show: - \t - \t path
        const output = await this.git.raw([
            'diff-tree', '--no-commit-id', '-r', '--numstat', sha,
        ]);
        if (!output.trim()) { return []; }
        return output.trim().split('\n').map((line) => {
            const tab1 = line.indexOf('\t');
            const tab2 = line.indexOf('\t', tab1 + 1);
            const ins = line.slice(0, tab1);
            const del = line.slice(tab1 + 1, tab2);
            const filePath = line.slice(tab2 + 1).trim();
            return {
                path: filePath,
                insertions: ins === '-' ? -1 : parseInt(ins, 10),
                deletions: del === '-' ? -1 : parseInt(del, 10),
            };
        });
    }

    private async fetchLineHistory(
        filePath: string,
        startLine: number,
        endLine: number
    ): Promise<FileHistoryEntry[]> {
        const relativePath = path.relative(this.repoRoot, filePath);
        const SEP = '\x1f';
        const output = await this.git.raw([
            'log',
            '--no-patch',
            `--format=%H${SEP}%an${SEP}%ae${SEP}%aI${SEP}%ar${SEP}%s`,
            `-L${startLine},${endLine}:${relativePath}`,
        ]);
        if (!output.trim()) { return []; }
        // Only keep lines starting with a 40-char hex SHA + separator
        return output.split('\n')
            .filter((line) => /^[0-9a-f]{40}\x1f/i.test(line))
            .map((line) => {
                const [sha, author, authorEmail, dateIso, relativeDate, message] = line.split(SEP);
                return {
                    sha: sha.trim(),
                    author: author.trim(),
                    authorEmail: authorEmail.trim(),
                    date: new Date(dateIso.trim()),
                    relativeDate: relativeDate.trim(),
                    message: message?.trim() ?? '',
                };
            });
    }

    private async fetchHotFiles(since: Date | null): Promise<HotFileEntry[]> {
        const args: string[] = ['log', '--format=COMMIT:%an', '--name-only'];
        if (since) {
            args.push(`--after=${since.toISOString()}`);
        }
        const output = await this.git.raw(args);
        if (!output.trim()) { return []; }

        const fileCounts = new Map<string, number>();
        const fileAuthors = new Map<string, Map<string, number>>();
        let currentAuthor = '';

        for (const raw of output.split('\n')) {
            const line = raw.trim();
            if (line.startsWith('COMMIT:')) {
                currentAuthor = line.slice(7);
            } else if (line) {
                fileCounts.set(line, (fileCounts.get(line) ?? 0) + 1);
                if (!fileAuthors.has(line)) { fileAuthors.set(line, new Map()); }
                const authorMap = fileAuthors.get(line)!;
                authorMap.set(currentAuthor, (authorMap.get(currentAuthor) ?? 0) + 1);
            }
        }

        return Array.from(fileCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 50)
            .map(([filePath, count]) => {
                const authorMap = fileAuthors.get(filePath)!;
                let topAuthor = '';
                let topCount = 0;
                for (const [author, cnt] of authorMap) {
                    if (cnt > topCount) { topCount = cnt; topAuthor = author; }
                }
                return { path: filePath, count, topAuthor };
            });
    }
}

// -------------------------------------------------------------------------
// Porcelain blame parser
// -------------------------------------------------------------------------

/**
 * Parses the output of `git blame --porcelain` into a line-number → BlameInfo map.
 *
 * Porcelain format per hunk:
 *   {sha} {origLine} {finalLine} {numLines}
 *   author {name}
 *   author-mail <{email}>
 *   author-time {unix-timestamp}
 *   author-tz {tz}
 *   committer ...
 *   summary {message}
 *   [previous ...]
 *   filename {filename}
 *   \t{line content}
 *
 * When the same sha appears more than once, git omits the headers for the
 * second and subsequent hunks. We track the last seen metadata per sha.
 */
function parsePorcelainBlame(output: string): Map<number, BlameInfo> {
    const result = new Map<number, BlameInfo>();

    // Metadata seen so far keyed by sha (re-used across hunks for the same commit)
    const metaCache = new Map<string, Omit<BlameInfo, 'lineNumber'>>();

    const lines = output.split('\n');
    let i = 0;

    while (i < lines.length) {
        const headerMatch = lines[i].match(/^([0-9a-f]{40}) \d+ (\d+)/);
        if (!headerMatch) {
            i++;
            continue;
        }

        const sha = headerMatch[1];
        const finalLine = parseInt(headerMatch[2], 10);
        i++;

        // Collect key-value pairs until we hit the \t line
        const meta: Partial<Record<string, string>> = {};
        while (i < lines.length && !lines[i].startsWith('\t')) {
            const spaceIdx = lines[i].indexOf(' ');
            if (spaceIdx !== -1) {
                const key = lines[i].slice(0, spaceIdx);
                const value = lines[i].slice(spaceIdx + 1);
                meta[key] = value;
            }
            i++;
        }
        i++; // skip the \t content line

        let info: Omit<BlameInfo, 'lineNumber'>;

        if (meta['author']) {
            // Full header block — parse and cache for this sha
            const email = (meta['author-mail'] ?? '').replace(/[<>]/g, '');
            const timestamp = parseInt(meta['author-time'] ?? '0', 10);
            info = {
                sha,
                author: meta['author'] ?? '',
                authorEmail: email,
                authorDate: new Date(timestamp * 1000),
                authorTimestamp: timestamp,
                summary: meta['summary'] ?? '',
            };
            metaCache.set(sha, info);
        } else {
            // Repeated sha — reuse cached metadata (git omits headers for repeats)
            const cached = metaCache.get(sha);
            if (!cached) {
                // Shouldn't happen with well-formed porcelain output, but guard anyway
                continue;
            }
            info = cached;
        }

        result.set(finalLine, { ...info, lineNumber: finalLine });
    }

    return result;
}
