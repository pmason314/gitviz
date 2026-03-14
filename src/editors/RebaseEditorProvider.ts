import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { RebaseAction, RebaseEntry } from '../git/types';

/**
 * CustomTextEditorProvider that intercepts `git-rebase-todo` files opened by
 * Git during an interactive rebase and replaces the plain-text editor with a
 * drag-and-drop webview UI.
 *
 * Git opens the file with the configured sequence editor (VS Code when
 * `git config core.sequenceeditor "code --wait"` or equivalent is set).
 * When the user saves/closes, Git reads the modified todo file and proceeds.
 */
export class RebaseEditorProvider
    implements vscode.CustomTextEditorProvider, vscode.Disposable
{
    static readonly viewType = 'gitlite.rebaseEditor';

    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly extensionUri: vscode.Uri) {}

    // -------------------------------------------------------------------------
    // CustomTextEditorProvider
    // -------------------------------------------------------------------------

    async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
    ): Promise<void> {
        let entries = parseTodo(document.getText());
        const originalText = document.getText();

        // If parse fails entirely, fall back to the built-in text editor
        if (entries.filter(e => !e.isComment).length === 0 && document.getText().trim().length > 0) {
            // File has content but no recognisable entries — could be post-rebase or corrupt
            // Still show the UI; the text is preserved as comment rows
        }

        webviewPanel.webview.options = { enableScripts: true };
        const entriesJson = JSON.stringify(entriesToMsg(entries));
        webviewPanel.webview.html = fs.readFileSync(path.join(this.extensionUri.fsPath, 'resources', 'rebaseEditor.html'), 'utf8')
            .replace('__ENTRIES_JSON__', entriesJson);

        // Sync external edits (e.g. git amending the todo file in-flight) back to the UI
        const onDocChange = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.toString() === document.uri.toString()) {
                entries = parseTodo(document.getText());
                webviewPanel.webview.postMessage({ type: 'update', entries: entriesToMsg(entries) });
            }
        });
        webviewPanel.onDidDispose(() => onDocChange.dispose());

        webviewPanel.webview.onDidReceiveMessage(async (msg: {
            type: string;
            from?: number; to?: number;
            index?: number; action?: RebaseAction; message?: string;
        }) => {
            switch (msg.type) {
                case 'reorder': {
                    const { from, to } = msg;
                    if (from === undefined || to === undefined || from === to) { break; }
                    // Only reorder non-comment entries; map UI index → entries index
                    const nonCommentIndices = entries
                        .map((e, i) => (!e.isComment ? i : -1))
                        .filter(i => i !== -1);
                    const fromIdx = nonCommentIndices[from];
                    const toIdx   = nonCommentIndices[to];
                    if (fromIdx === undefined || toIdx === undefined) { break; }
                    const [moved] = entries.splice(fromIdx, 1);
                    entries.splice(toIdx, 0, moved);
                    await writeBack(document, entries);
                    webviewPanel.webview.postMessage({ type: 'update', entries: entriesToMsg(entries) });
                    break;
                }
                case 'setAction': {
                    const { index, action } = msg;
                    if (index === undefined || !action) { break; }
                    const nonCommentIndices = entries
                        .map((e, i) => (!e.isComment ? i : -1))
                        .filter(i => i !== -1);
                    const entryIdx = nonCommentIndices[index];
                    if (entryIdx === undefined) { break; }
                    entries[entryIdx].action = action;
                    entries[entryIdx].raw = `${action} ${entries[entryIdx].sha} ${entries[entryIdx].message}`;
                    await writeBack(document, entries);
                    break;
                }
                case 'setMessage': {
                    const { index, message } = msg;
                    if (index === undefined || message === undefined) { break; }
                    const nonCommentIndices = entries
                        .map((e, i) => (!e.isComment ? i : -1))
                        .filter(i => i !== -1);
                    const entryIdx = nonCommentIndices[index];
                    if (entryIdx === undefined) { break; }
                    entries[entryIdx].message = message;
                    break;
                }
                case 'save': {
                    const saveEdit = new vscode.WorkspaceEdit();
                    saveEdit.replace(
                        document.uri,
                        new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
                        serializeForSave(entries),
                    );
                    await vscode.workspace.applyEdit(saveEdit);
                    await document.save();
                    webviewPanel.dispose();
                    break;
                }
                case 'reset': {
                    entries = parseTodo(originalText);
                    await writeBack(document, entries);
                    webviewPanel.webview.postMessage({ type: 'update', entries: entriesToMsg(entries) });
                    break;
                }
                case 'configureEditor': {
                    // User asked to set VS Code as sequence editor
                    const terminal = vscode.window.createTerminal('GitLite: Configure Rebase');
                    terminal.sendText('git config --global sequence.editor "code --wait"');
                    terminal.show();
                    break;
                }
            }
        });
    }

    dispose(): void {
        for (const d of this.disposables) { d.dispose(); }
    }
}

// ---------------------------------------------------------------------------
// Parse / serialize helpers
// ---------------------------------------------------------------------------

const ACTION_RE = /^(pick|squash|fixup|reword|edit|drop|p|s|f|r|e|d)\s+([0-9a-f]+)\s*(.*)/i;

const ACTION_ALIASES: Record<string, RebaseAction> = {
    p: 'pick', s: 'squash', f: 'fixup', r: 'reword', e: 'edit', d: 'drop',
};

function normaliseAction(raw: string): RebaseAction {
    const lower = raw.toLowerCase();
    return (ACTION_ALIASES[lower] ?? lower) as RebaseAction;
}

export function parseTodo(text: string): RebaseEntry[] {
    return text.split('\n').map((line): RebaseEntry => {
        const m = ACTION_RE.exec(line);
        if (m) {
            const action = normaliseAction(m[1]);
            const message = m[3].trim();
            return { action, sha: m[2], message, origMessage: message, isComment: false, raw: line };
        }
        return { action: 'pick', sha: '', message: '', origMessage: '', isComment: true, raw: line };
    });
}

export function serializeTodo(entries: RebaseEntry[]): string {
    return entries.map(e => {
        if (e.isComment) { return e.raw; }
        return `${e.action} ${e.sha} ${e.message}`;
    }).join('\n');
}

function shellSingleQuote(s: string): string {
    return "'" + s.replace(/'/g, "'\\''" ) + "'";
}

/** Build `-m 'para1' -m 'para2' ...` flags for `git commit --amend`.
 *  Splits on paragraph breaks so the exec line is always a single line in the todo file.
 *  Intra-paragraph newlines are collapsed to a space. */
function shellAmendFlags(message: string): string {
    const paragraphs = message.trim()
        .split(/\n\n+/)
        .map(p => p.replace(/\n/g, ' ').trim())
        .filter(p => p.length > 0);
    if (paragraphs.length === 0) { return `-m ${shellSingleQuote('')}`; }
    return paragraphs.map(p => `-m ${shellSingleQuote(p)}`).join(' ');
}

function serializeForSave(entries: RebaseEntry[]): string {
    const lines: string[] = [];
    // Separate action entries from trailing comment lines (git always puts comments last)
    const actions = entries.filter(e => !e.isComment);
    const comments = entries.filter(e => e.isComment);

    let i = 0;
    while (i < actions.length) {
        const e = actions[i];
        const msgChanged = e.message.trim() !== e.origMessage.trim();

        if (e.action === 'drop') {
            lines.push(`drop ${e.sha} ${e.message}`); i++; continue;
        }
        if (e.action === 'edit') {
            lines.push(`edit ${e.sha} ${e.message}`); i++; continue;
        }
        if (e.action === 'squash' || e.action === 'fixup') {
            // Orphaned squash/fixup (no preceding pick) — treat as pick
            lines.push(`pick ${e.sha} ${e.message}`); i++; continue;
        }

        // action is 'pick' or 'reword' — look ahead for a squash/fixup group, skipping drops
        let j = i + 1;
        while (j < actions.length && (actions[j].action === 'squash' || actions[j].action === 'fixup' || actions[j].action === 'drop')) { j++; }
        const hasSquashMember = actions.slice(i + 1, j).some(a => a.action === 'squash' || a.action === 'fixup');

        if (hasSquashMember) {
            // Squash group (drops allowed in between): the head entry's message holds the full combined message.
            // (The webview initializes it to the combined text via setMessage on first render,
            // and updates it when the user edits the combined-msg textarea.)
            const combined = e.message.trim() || e.origMessage.trim();
            lines.push(`pick ${e.sha} ${e.origMessage}`);
            for (let k = i + 1; k < j; k++) {
                if (actions[k].action === 'drop') {
                    lines.push(`drop ${actions[k].sha} ${actions[k].origMessage}`);
                } else {
                    lines.push(`fixup ${actions[k].sha} ${actions[k].origMessage}`);
                }
            }
            lines.push(`exec git commit --amend ${shellAmendFlags(combined)}`);            i = j;
        } else if (msgChanged) {
            // Inline-edited message: amend via exec so no editor popup is triggered
            lines.push(`pick ${e.sha} ${e.origMessage}`);
            lines.push(`exec git commit --amend ${shellAmendFlags(e.message.trim())}`);
            i++;
        } else if (e.action === 'reword') {
            // reword with no message change — no editor needed, treat as plain pick
            lines.push(`pick ${e.sha} ${e.message}`); i++;
        } else {
            lines.push(`${e.action} ${e.sha} ${e.message}`); i++;
        }
    }

    for (const e of comments) { lines.push(e.raw); }
    return lines.join('\n');
}

function entriesToMsg(entries: RebaseEntry[]) {
    return entries.map(e => ({
        action: e.action,
        sha: e.sha,
        message: e.message,
        origMessage: e.origMessage,
        isComment: e.isComment,
        raw: e.raw,
    }));
}

async function writeBack(document: vscode.TextDocument, entries: RebaseEntry[]): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length),
    );
    edit.replace(document.uri, fullRange, serializeTodo(entries));
    await vscode.workspace.applyEdit(edit);
}

