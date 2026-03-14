import * as path from 'path';
import * as vscode from 'vscode';
import { GitService } from '../git/GitService';

export const REVISION_SCHEME = 'gitviz';

/**
 * Build a virtual URI for a file at a specific git revision.
 *
 * Format:  gitviz://{sha}/{relative/path/to/file}
 *
 * `sha` may be any git revision: a 40-char hash, `HEAD~1`, `abc123~1`, etc.
 * The `~` character is an RFC 3986 unreserved character so it round-trips
 * through VS Code's URI handling without percent-encoding.
 *
 * @param repoRoot  Absolute path to the repository root.
 * @param sha       Any git revision.
 * @param absFilePath  Absolute path to the file.
 */
export function makeRevisionUri(repoRoot: string, sha: string, absFilePath: string): vscode.Uri {
    const relativePath = path.relative(repoRoot, absFilePath);
    return vscode.Uri.from({
        scheme: REVISION_SCHEME,
        authority: sha,
        path: '/' + relativePath.replace(/\\/g, '/'),
    });
}

/**
 * TextDocumentContentProvider that serves the content of any file
 * at any git revision using the `gitviz:` URI scheme.
 */
export class RevisionContentProvider
    implements vscode.TextDocumentContentProvider, vscode.Disposable
{
    private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;

    constructor(private readonly gitService: GitService) {}

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const sha = uri.authority;
        const relativePath = uri.path.replace(/^\//, ''); // strip leading /
        try {
            return await this.gitService.getFileAtRevision(relativePath, sha);
        } catch {
            // File didn't exist at this revision (added or deleted in the commit).
            // Return empty content so the diff editor shows a clean add/delete.
            return '';
        }
    }

    dispose(): void {
        this._onDidChange.dispose();
    }
}
