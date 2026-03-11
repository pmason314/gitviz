import { CommitInfo } from './types';

const MAX_ENTRIES = 200;

/**
 * LRU cache for commit detail objects.
 * Capped at MAX_ENTRIES. Avoids repeated `git show` calls for the same SHA.
 */
export class CommitCache {
    private readonly cache = new Map<string, CommitInfo>();

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
        if (this.cache.size >= MAX_ENTRIES) {
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
