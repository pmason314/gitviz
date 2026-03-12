export interface BlameInfo {
    sha: string;
    author: string;
    authorEmail: string;
    authorDate: Date;
    /** Unix timestamp as string, as returned by git blame --porcelain */
    authorTimestamp: number;
    summary: string;
    lineNumber: number;
}

export interface CommitInfo {
    sha: string;
    author: string;
    authorEmail: string;
    date: Date;
    message: string;
    body: string;
    /** Output of git show --stat (file change summary) */
    diffStats: string;
}

export interface FileHistoryEntry {
    sha: string;
    author: string;
    authorEmail: string;
    date: Date;
    relativeDate: string;
    message: string;
}

/** Per-file entry from git diff-tree --numstat. insertions/deletions are -1 for binary files. */
export interface CommitFileEntry {
    path: string;
    insertions: number;
    deletions: number;
}

export interface HotFileEntry {
    path: string;
    count: number;
    topAuthor: string;
}
