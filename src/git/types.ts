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

// ---------------------------------------------------------------------------
// Phase 3 — Sidebar Repository Views
// ---------------------------------------------------------------------------

export interface BranchInfo {
    name: string;
    sha: string;
    subject: string;
    isCurrent: boolean;
    /** Upstream tracking branch short name, e.g. "origin/main", or "" if none. */
    upstream: string;
    /** True when upstream was set but git reports it as gone (pruned from remote). */
    upstreamGone: boolean;
    ahead: number;
    behind: number;
}

export interface RemoteBranchInfo {
    /** Full short name, e.g. "origin/main" */
    fullName: string;
    /** Branch name without remote prefix, e.g. "main" */
    shortName: string;
    sha: string;
    subject: string;
}

export interface RemoteInfo {
    name: string;
    fetchUrl: string;
    branches: RemoteBranchInfo[];
}

export interface TagInfo {
    name: string;
    /** The commit SHA this tag points to (dereferenced for annotated tags). */
    sha: string;
    date: string;
    subject: string;
    isAnnotated: boolean;
}

export interface StashInfo {
    /** Stash ref, e.g. "stash@{0}" */
    ref: string;
    message: string;
    relativeDate: string;
}

export interface ContributorInfo {
    name: string;
    email: string;
    commitCount: number;
}

export interface CommitEntry {
    sha: string;
    author: string;
    date: Date;
    relativeDate: string;
    message: string;
}
