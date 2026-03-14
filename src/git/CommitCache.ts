import { CommitInfo } from './types';

/**
 * LRU cache for commit detail objects.
 * Capped at maxEntries. Avoids repeated `git show` calls for the same SHA.
 */
export class CommitCache {
    private readonly cache = new Map<string, CommitInfo>();
    private readonly maxEntries: number;

    constructor(maxEntries = 200) {
        this.maxEntries = maxEntries;
    }

    get(sha: string): CommitInfo | undefined {
        const entry = this.cache.get(sha);
        if (entry === undefined) {
            return undefined;
        }
        // Move to end (most recently used)
        this.cache.delete(sha);
        this.cache.set(sha, entry);
        return entry;
    }

    set(sha: string, data: CommitInfo): void {
        this.cache.delete(sha);
        if (this.cache.size >= this.maxEntries) {
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) {
                this.cache.delete(oldest);
            }
        }
        this.cache.set(sha, data);
    }

    has(sha: string): boolean {
        return this.cache.has(sha);
    }

    clear(): void {
        this.cache.clear();
    }
}
