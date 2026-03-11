import { BlameInfo } from './types';

const MAX_FILES = 50;

/**
 * LRU cache for whole-file blame data.
 * Keys are absolute file paths. Capped at MAX_FILES entries to prevent OOM
 * on long sessions with many open files.
 *
 * Also tracks in-flight fetch promises so multiple callers for the same file
 * share a single git blame process rather than spawning duplicates.
 */
export class BlameCache {
    private readonly cache = new Map<string, Map<number, BlameInfo>>();
    private readonly inFlight = new Map<string, Promise<Map<number, BlameInfo>>>();

    get(filePath: string): Map<number, BlameInfo> | undefined {
        const entry = this.cache.get(filePath);
        if (entry === undefined) {
            return undefined;
        }
        // Move to end (most recently used)
        this.cache.delete(filePath);
        this.cache.set(filePath, entry);
        return entry;
    }

    set(filePath: string, data: Map<number, BlameInfo>): void {
        // Move to end if already present
        this.cache.delete(filePath);
        if (this.cache.size >= MAX_FILES) {
            // Evict least recently used (first entry)
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) {
                this.cache.delete(oldest);
            }
        }
        this.cache.set(filePath, data);
    }

    invalidate(filePath: string): void {
        this.cache.delete(filePath);
    }

    clear(): void {
        this.cache.clear();
        this.inFlight.clear();
    }

    /**
     * Check cache first; if missing and not already in-flight, call fetcher.
     * Multiple concurrent callers for the same file share the same Promise.
     */
    async getOrFetch(
        filePath: string,
        fetcher: () => Promise<Map<number, BlameInfo>>
    ): Promise<Map<number, BlameInfo>> {
        const cached = this.get(filePath);
        if (cached !== undefined) {
            return cached;
        }

        const existing = this.inFlight.get(filePath);
        if (existing !== undefined) {
            return existing;
        }

        const promise = fetcher().then((data) => {
            this.set(filePath, data);
            this.inFlight.delete(filePath);
            return data;
        }).catch((err) => {
            this.inFlight.delete(filePath);
            throw err;
        });

        this.inFlight.set(filePath, promise);
        return promise;
    }
}
