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
    /** A=added, M=modified, D=deleted, R=renamed, C=copied, ?=unknown */
    status: 'A' | 'M' | 'D' | 'R' | 'C' | '?';
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
    /** Branch the stash was created on, e.g. "main" */
    branch: string;
    relativeDate: string;
}

export interface WorktreeInfo {
    /** Absolute filesystem path of the worktree. */
    path: string;
    /** Full commit SHA that HEAD points to. Empty for a bare worktree. */
    head: string;
    /** Full ref name, e.g. "refs/heads/main". Empty for detached HEAD or bare. */
    branch: string;
    /** True for a bare worktree. */
    isBare: boolean;
    /** Number of staged (index) changes. */
    staged: number;
    /** Number of unstaged + untracked changes. */
    unstaged: number;
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

// ---------------------------------------------------------------------------
// Phase 4a — Interactive Rebase Editor
// ---------------------------------------------------------------------------

export type RebaseAction = 'pick' | 'squash' | 'fixup' | 'reword' | 'edit' | 'drop';

export interface RebaseEntry {
    action: RebaseAction;
    sha: string;
    message: string;
    /** Original message captured at open time; used to detect edits and inject exec-amend on save. */
    origMessage: string;
    /** True for comment/blank lines — preserved verbatim, not interactive. */
    isComment: boolean;
    /** Raw source line, used when isComment=true for lossless round-tripping. */
    raw: string;
}

// ---------------------------------------------------------------------------
// Phase 4b — Commit Graph
// ---------------------------------------------------------------------------

/** One commit node in the commit graph, including parent SHAs for DAG edges. */
export interface CommitGraphEntry {
    sha: string;
    /** Full SHAs of parent commits (empty for root commits, two+ for merges). */
    parents: string[];
    author: string;
    date: Date;
    relativeDate: string;
    message: string;
}

/** A ref (branch, remote-tracking branch, tag, or HEAD) positioned on a graph node. */
export interface GraphRef {
    sha: string;
    /** Human-readable short name, e.g. "main", "origin/main", "v1.0" */
    name: string;
    type: 'branch' | 'remote' | 'tag' | 'HEAD';
    /** True only for the currently checked-out branch. */
    isCurrent?: boolean;
}

/**
 * A ref option surfaced in the Compare view's QuickPick picker.
 * Shape is a superset of vscode.QuickPickItem so it works directly with showQuickPick.
 */
export interface RefItem {
    /** Label shown in the quick pick (includes a codicon prefix). */
    label: string;
    /** Short SHA or relative date shown to the right of the label. */
    description: string;
    /** Commit subject shown below the label. */
    detail?: string;
    /** The actual ref string to use in git commands (empty string = working dir). */
    value: string;
}
