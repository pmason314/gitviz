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
        webviewPanel.webview.html = buildHtml(entries);

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

// ---------------------------------------------------------------------------
// HTML builder
// ---------------------------------------------------------------------------

function buildHtml(initialEntries: RebaseEntry[]): string {
    const entriesJson = JSON.stringify(entriesToMsg(initialEntries));
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; overflow: hidden; display: flex; flex-direction: column; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}
/* ---- Header ---- */
#header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: var(--vscode-editor-background);
  border-bottom: 1px solid var(--vscode-editorWidget-border, var(--vscode-focusBorder));
  flex-shrink: 0;
}
#header h2 { font-size: 1em; font-weight: 600; flex: 1; }
.hdr-btn {
  padding: 3px 10px;
  font: inherit;
  font-size: 0.85em;
  cursor: pointer;
  border-radius: 3px;
  border: 1px solid transparent;
}
.hdr-btn-primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border-color: var(--vscode-button-background);
}
.hdr-btn-primary:hover { background: var(--vscode-button-hoverBackground); }
.hdr-btn-secondary {
  background: var(--vscode-button-secondaryBackground, #555);
  color: var(--vscode-button-secondaryForeground, #fff);
}
.hdr-btn-secondary:hover { opacity: 0.85; }
/* ---- Setup notice ---- */
#setup-notice {
  display: none;
  padding: 6px 12px;
  font-size: 0.85em;
  background: var(--vscode-inputValidation-infoBackground, #1f3b57);
  border-bottom: 1px solid var(--vscode-inputValidation-infoBorder, #007acc);
  flex-shrink: 0;
  gap: 8px;
  align-items: center;
}
#setup-notice a {
  color: var(--vscode-textLink-foreground, #3794ff);
  cursor: pointer;
  text-decoration: underline;
}
/* ---- Entry list ---- */
#entry-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}
/* ---- Single row ---- */
.entry-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 12px;
  height: 26px;
  user-select: none;
  border: 1px solid transparent;
  border-radius: 3px;
  margin: 1px 6px;
}
.entry-row:hover { background: var(--vscode-list-hoverBackground); }
.entry-row.drag-over { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); }
.entry-row.drop-action {
  opacity: 0.45;
  text-decoration: line-through;
  text-decoration-color: var(--vscode-errorForeground, #f48771);
}
.drag-handle {
  cursor: grab;
  opacity: 0.4;
  font-size: 14px;
  flex-shrink: 0;
  line-height: 1;
}
.drag-handle:active { cursor: grabbing; }
.action-select {
  flex-shrink: 0;
  width: 72px;
  background: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground);
  border: 1px solid var(--vscode-dropdown-border, transparent);
  border-radius: 3px;
  font: inherit;
  font-size: 0.85em;
  padding: 1px 4px;
  cursor: pointer;
}
.action-select.action-pick   { color: var(--vscode-foreground); }
.action-select.action-squash { color: #d29922; }
.action-select.action-fixup  { color: #d29922; }
.action-select.action-reword { color: #58a6ff; }
.action-select.action-edit   { color: #58a6ff; }
.action-select.action-drop   { color: var(--vscode-errorForeground, #f48771); }
/* Options inside the dropdown should not inherit the select's action colour */
.action-select option { color: var(--vscode-dropdown-foreground); }
.action-select option:disabled { color: var(--vscode-disabledForeground, rgba(204,204,204,0.4)); }
.sha-badge {
  flex-shrink: 0;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 0.82em;
  color: var(--vscode-descriptionForeground);
  min-width: 52px;
}
.entry-msg-input {
  flex: 1;
  background: transparent;
  color: inherit;
  border: 1px solid transparent;
  border-radius: 3px;
  font: inherit;
  font-size: 0.93em;
  padding: 0 4px;
  min-width: 0;
}
.entry-msg-input:hover:not(:focus) { border-color: var(--vscode-input-border, rgba(255,255,255,0.12)); }
.entry-msg-input:focus {
  outline: none;
  border-color: var(--vscode-focusBorder);
  background: var(--vscode-input-background);
}
/* Comment rows */
.comment-row {
  padding: 1px 12px 1px 36px;
  color: var(--vscode-descriptionForeground);
  font-size: 0.82em;
  font-family: var(--vscode-editor-font-family, monospace);
  opacity: 0.55;
  white-space: pre;
  overflow: hidden;
  text-overflow: ellipsis;
}
.blank-row { height: 6px; }
/* ---- Squash / fixup group rows ---- */
.group-wrapper {
  display: flex;
  align-items: stretch;
  gap: 4px;
  margin: 1px 6px;
  border-radius: 3px;
}
.group-wrapper .entry-row {
  margin: 0;
}
.group-rows {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
}
.combined-msg {
  flex: 1;
  background: var(--vscode-input-background);
  color: inherit;
  border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.12));
  border-radius: 3px;
  font: inherit;
  font-size: 0.93em;
  padding: 2px 4px;
  min-width: 0;
  resize: none;
  overflow-y: auto;
  line-height: 1.4;
}
.combined-msg:focus {
  outline: none;
  border-color: var(--vscode-focusBorder);
  background: var(--vscode-input-background);
}
.entry-row.member-row {
  opacity: 0.55;
}
/* ---- Help panel ---- */
#help-panel {
  border-top: 1px solid var(--vscode-editorWidget-border, var(--vscode-focusBorder));
  margin: 6px 6px 4px;
  padding: 6px 8px 10px;
  font-size: 0.9em;
  color: var(--vscode-descriptionForeground);
}
#help-panel .help-title {
  font-size: 0.85em;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  opacity: 0.55;
  margin-bottom: 4px;
}
#help-panel .help-grid {
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: 16px;
  row-gap: 3px;
  line-height: 1.6;
}
#help-panel .help-cmd {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 0.95em;
  color: var(--vscode-foreground);
  white-space: nowrap;
}
#help-panel .help-desc { opacity: 0.8; }
</style>
</head>
<body>
<div id="header">
  <div style="flex:1;min-width:0">
    <h2>Interactive Rebase</h2>
    <p style="font-size:0.78em;opacity:0.65;margin-top:1px">Commits are listed chronologically with the oldest at the top and newest at the bottom</p>
  </div>
  <button class="hdr-btn hdr-btn-secondary" id="btn-reset">Reset</button>
  <button class="hdr-btn hdr-btn-primary"   id="btn-save">Save &amp; Start Rebase</button>
</div>
<div id="setup-notice">
  ℹ\uFE0E&nbsp;VS Code is not configured as your Git sequence editor.
  <a id="setup-link">Click here to configure automatically</a>, or run:
  <code>git config --global sequence.editor "code --wait"</code>
</div>
<div id="entry-list"></div>
<script>
(function() {
'use strict';
var vsc = acquireVsCodeApi();
var ACTIONS = ['pick','squash','fixup','reword','edit','drop'];
var ACTION_KEYS = { p:'pick', s:'squash', f:'fixup', r:'reword', e:'edit', d:'drop' };

var entries = ${entriesJson};
var dragSrcIdx = null;

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function nonCommentEntries() {
  return entries.filter(function(e) { return !e.isComment; });
}

var ACTION_COLORS = {
  pick: '#3fb950', reword: '#58a6ff', edit: '#e3b341',
  squash: '#d29922', fixup: '#c6862c', drop: '#f85149'
};

function computeGroupInfo(nc) {
  var info = nc.map(function(e) {
    var a = e.action;
    return (a === 'squash' || a === 'fixup') ? 'member' : a === 'drop' ? 'drop' : 'head';
  });
  // Upgrade heads that have squash/fixup members after them (drops interspersed are allowed)
  // to 'group-head'. Mark any drops in that run as 'group-drop'.
  // Scan the full consecutive run of member/drop entries before deciding.
  for (var i = 0; i < nc.length; i++) {
    if (info[i] !== 'head') { continue; }
    // Find the end of the consecutive member/drop run
    var j = i + 1;
    while (j < nc.length && (info[j] === 'member' || info[j] === 'drop')) { j++; }
    // Only upgrade if at least one member exists in that run
    var hasMember = false;
    for (var k = i + 1; k < j; k++) {
      if (info[k] === 'member') { hasMember = true; break; }
    }
    if (hasMember) {
      info[i] = 'group-head';
      for (var d = i + 1; d < j; d++) {
        if (info[d] === 'drop') { info[d] = 'group-drop'; }
      }
    }
  }
  return info;
}

function buildCombinedMessage(nc, headIdx, groupInfo) {
  var parts = [nc[headIdx].message.trim()];
  for (var k = headIdx + 1; k < nc.length; k++) {
    if (groupInfo[k] === 'group-drop') { continue; } // skip dropped commits in the group
    if (groupInfo[k] !== 'member') { break; }
    if (nc[k].action === 'squash') { parts.push(nc[k].message.trim()); }
  }
  return parts.filter(function(p) { return p.length > 0; }).join('\\n\\n')
    || nc[headIdx].origMessage.trim();
}

function renderRowSvg(ncIdx, groupInfo, nc) {
  var type = groupInfo[ncIdx];
  // group-drop renders the same as drop for the SVG graph
  if (type === 'group-drop') { type = 'drop'; }
  var color = ACTION_COLORS[nc[ncIdx].action] || '#888';
  var hasPrev = ncIdx > 0;
  var hasNext = ncIdx < nc.length - 1;
  var p = [];
  if (type === 'head') {
    if (hasPrev) p.push('<line x1="8" y1="0" x2="8" y2="13" stroke="currentColor" stroke-width="1.5"/>');
    if (hasNext) p.push('<line x1="8" y1="13" x2="8" y2="26" stroke="currentColor" stroke-width="1.5"/>');
    p.push('<circle cx="8" cy="13" r="4" fill="' + color + '"/>');
  } else if (type === 'member') {
    p.push('<line x1="8" y1="0" x2="8" y2="26" stroke="currentColor" stroke-width="1.5"/>');
    p.push('<path d="M8,0 C8,8 18,5 18,13" stroke="' + color + '" stroke-width="1.5" fill="none"/>');
    p.push('<circle cx="18" cy="13" r="3" fill="' + color + '"/>');
  } else {
    if (hasPrev) p.push('<line x1="8" y1="0" x2="8" y2="13" stroke="currentColor" stroke-width="1" stroke-dasharray="3,2" opacity="0.4"/>');
    if (hasNext) p.push('<line x1="8" y1="13" x2="8" y2="26" stroke="currentColor" stroke-width="1" stroke-dasharray="3,2" opacity="0.4"/>');
    p.push('<line x1="5" y1="10" x2="11" y2="16" stroke="' + color + '" stroke-width="2"/>');
    p.push('<line x1="11" y1="10" x2="5" y2="16" stroke="' + color + '" stroke-width="2"/>');
  }
  // Directional arrows: downward chevron after the first node, and a dashed
  // extension + chevron below the last node, so the oldest→HEAD direction is clear.
  if (ncIdx === 0 && nc.length > 1) {
    // Short dashed line above the first (oldest) node — full brightness to match other edges
    p.push('<line x1="8" y1="0" x2="8" y2="9" stroke="currentColor" stroke-width="1" stroke-dasharray="2,2"/>');
  }
  if (ncIdx === nc.length - 1 && nc.length > 1) {
    p.push('<line x1="8" y1="17" x2="8" y2="21" stroke="currentColor" stroke-width="1" stroke-dasharray="2,2"/>');
    p.push('<polyline points="5.5,19 8,23 10.5,19" stroke="currentColor" stroke-width="1.5" fill="none"/>');
  }
  return '<svg width="28" height="26" viewBox="0 0 28 26" style="flex-shrink:0;color:var(--vscode-descriptionForeground);pointer-events:none">'
    + p.join('') + '</svg>';
}

function render() {
  var list = document.getElementById('entry-list');
  var nc = nonCommentEntries();
  var groupInfo = computeGroupInfo(nc);
  var firstActiveIdx = nc.findIndex(function(x) { return x.action !== 'drop'; });

  function makeSelOptions(myIdx, e) {
    return ACTIONS.map(function(a) {
      var cantSquash = myIdx <= firstActiveIdx && (a === 'squash' || a === 'fixup');
      return '<option value="' + a + '"' + (e.action === a ? ' selected' : '') + (cantSquash ? ' disabled' : '') + '>' + a + '</option>';
    }).join('');
  }

  function makeLeftCells(myIdx, e, gi) {
    return renderRowSvg(myIdx, groupInfo, nc)
      + '<span class="drag-handle" aria-hidden="true">\u283F</span>'
      + '<select class="action-select action-' + esc(e.action) + '" data-idx="' + myIdx + '">' + makeSelOptions(myIdx, e) + '</select>'
      + '<span class="sha-badge">' + esc(e.sha.slice(0,7)) + '</span>'
          + '';
  }

  var html = '';
  var i = 0;
  while (i < nc.length) {
    var e = nc[i];
    var gi = groupInfo[i];
    if (gi === 'group-head') {
      // Find end of this group
      var j = i + 1;
      while (j < nc.length && (groupInfo[j] === 'member' || groupInfo[j] === 'group-drop')) { j++; }
      // Initialize combined message on first render
      if (e.combinedMessage === undefined) {
        e.combinedMessage = buildCombinedMessage(nc, i, groupInfo);
        vsc.postMessage({ type: 'setMessage', index: i, message: e.combinedMessage });
      }
      html += '<div class="group-wrapper">';
      html += '<div class="group-rows">';
      // Head row (left side only — no text input)
      html += '<div class="entry-row" draggable="true" data-idx="' + i + '" tabindex="0">'
        + makeLeftCells(i, e, gi) + '</div>';
      // Member / group-drop rows
      for (var k = i + 1; k < j; k++) {
        var ke = nc[k];
        var kClass = 'entry-row member-row' + (groupInfo[k] === 'group-drop' ? ' drop-action' : '');
        html += '<div class="' + kClass + '" draggable="true" data-idx="' + k + '" tabindex="0">'
          + makeLeftCells(k, ke, groupInfo[k]) + '</div>';
      }
      html += '</div>'; // .group-rows
      html += '<textarea class="combined-msg" data-idx="' + i + '">' + esc(e.combinedMessage) + '</textarea>';
      html += '</div>'; // .group-wrapper
      i = j;
    } else {
      var rowClass = 'entry-row' + (gi === 'drop' ? ' drop-action' : '');
      html += '<div class="' + rowClass + '" draggable="true" data-idx="' + i + '" tabindex="0">'
        + makeLeftCells(i, e, gi)
        + '<input type="text" class="entry-msg-input" data-idx="' + i + '" value="' + esc(e.message) + '" title="' + esc(e.message) + '">'
        + '</div>';
      i++;
    }
  }

  html += '<div id="help-panel">'
    + '<div class="help-title">Rebase Commands</div>'
    + '<div class="help-grid">'
    + '<span class="help-cmd">pick</span><span class="help-desc">Use the commit as-is</span>'
    + '<span class="help-cmd">reword</span><span class="help-desc">Use the commit, but edit its message</span>'
    + '<span class="help-cmd">edit</span><span class="help-desc">Pause after applying so you can amend the commit</span>'
    + '<span class="help-cmd">squash</span><span class="help-desc">Meld into the previous commit, combining both messages</span>'
    + '<span class="help-cmd">fixup</span><span class="help-desc">Meld into the previous commit, discarding this message</span>'
    + '<span class="help-cmd">drop</span><span class="help-desc">Remove the commit entirely</span>'
    + '</div>'
    + '</div>';
  list.innerHTML = html;
}

// ---- Drag-and-drop reorder ----
var list = document.getElementById('entry-list');

// Ensure the first non-drop commit never ends up as squash/fixup after a reorder
function fixFirstAction() {
  var nc = nonCommentEntries();
  var firstActive = nc.findIndex(function(x) { return x.action !== 'drop'; });
  if (firstActive !== -1 && (nc[firstActive].action === 'squash' || nc[firstActive].action === 'fixup')) {
    nc[firstActive].action = 'pick';
    vsc.postMessage({ type: 'setAction', index: firstActive, action: 'pick' });
  }
}

list.addEventListener('dragstart', function(e) {
  if (e.target.closest('.entry-msg-input, .combined-msg')) { e.preventDefault(); return; }
  var row = e.target.closest('.entry-row');
  if (!row) { return; }
  dragSrcIdx = parseInt(row.dataset.idx, 10);
  e.dataTransfer.effectAllowed = 'move';
});

list.addEventListener('dragover', function(e) {
  var row = e.target.closest('.entry-row');
  if (!row || row.dataset.idx === undefined) { return; }
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  list.querySelectorAll('.entry-row').forEach(function(r) { r.classList.remove('drag-over'); });
  row.classList.add('drag-over');
});

list.addEventListener('dragleave', function(e) {
  var row = e.target.closest('.entry-row');
  if (row) { row.classList.remove('drag-over'); }
});

list.addEventListener('drop', function(e) {
  e.preventDefault();
  list.querySelectorAll('.entry-row').forEach(function(r) { r.classList.remove('drag-over'); });
  var row = e.target.closest('.entry-row');
  if (!row || dragSrcIdx === null) { return; }
  var toIdx = parseInt(row.dataset.idx, 10);
  if (toIdx === dragSrcIdx) { return; }
  // Reorder locally for immediate feedback
  var nc = nonCommentEntries();
  var moved = nc[dragSrcIdx];
  var target = nc[toIdx];
  // Find full-array indices
  var fullMoved = entries.indexOf(moved);
  var fullTarget = entries.indexOf(target);
  entries.splice(fullMoved, 1);
  // re-find target after splice
  var fullTarget2 = entries.indexOf(target);
  entries.splice(fullTarget2, 0, moved);
  fixFirstAction();
  // Invalidate combined messages since group composition may have changed after reorder
  nonCommentEntries().forEach(function(x, xi) {
    if (x.combinedMessage !== undefined) {
      x.message = x.origMessage;
      vsc.postMessage({ type: 'setMessage', index: xi, message: x.origMessage });
      delete x.combinedMessage;
    }
  });
  render();
  vsc.postMessage({ type: 'reorder', from: dragSrcIdx, to: toIdx });
  dragSrcIdx = null;
});

list.addEventListener('dragend', function() {
  list.querySelectorAll('.entry-row').forEach(function(r) { r.classList.remove('drag-over'); });
  dragSrcIdx = null;
});

// ---- Action select ----
list.addEventListener('change', function(e) {
  var sel = e.target.closest('.action-select');
  if (sel) {
    var idx = parseInt(sel.dataset.idx, 10);
    var action = sel.value;
    var nc = nonCommentEntries();
    // No commit at or before the first non-dropped entry has a predecessor to meld into
    var firstActive = nc.findIndex(function(x) { return x.action !== 'drop'; });
    if (idx <= firstActive && (action === 'squash' || action === 'fixup')) {
      sel.value = nc[idx].action;
      return;
    }
    var prevAction = nc[idx].action;
    nc[idx].action = action;
    var wasMember = (prevAction === 'squash' || prevAction === 'fixup');
    var isMember  = (action   === 'squash' || action   === 'fixup');
    // Group structure changes when drop status or member status changes.
    // Full re-render is needed to update disabled options and combined textareas.
    var dropStatusChanged = (action === 'drop') !== (prevAction === 'drop');
    var groupTransition = (wasMember !== isMember) || dropStatusChanged;
    if (groupTransition) {
      // Invalidate combined messages so render() recomputes them for the new groups
      for (var gi = 0; gi < nc.length; gi++) {
        if (nc[gi].combinedMessage !== undefined) {
          nc[gi].message = nc[gi].origMessage;
          vsc.postMessage({ type: 'setMessage', index: gi, message: nc[gi].origMessage });
          delete nc[gi].combinedMessage;
        }
      }
      vsc.postMessage({ type: 'setAction', index: idx, action: action });
      render();
      return;
    }
    sel.className = 'action-select action-' + action;
    var row = sel.closest('.entry-row');
    if (row) {
      if (action === 'drop') { row.classList.add('drop-action'); }
      else { row.classList.remove('drop-action'); }
      var inp = row.querySelector('.entry-msg-input');
      if (inp) {
        inp.classList.remove('msg-squash', 'msg-fixup');
        if (action === 'squash') { inp.classList.add('msg-squash'); }
        else if (action === 'fixup') { inp.classList.add('msg-fixup'); }
      }
    }
    vsc.postMessage({ type: 'setAction', index: idx, action: action });
  }
  var inp = e.target.closest('.entry-msg-input');
  if (inp) {
    var idx2 = parseInt(inp.dataset.idx, 10);
    nonCommentEntries()[idx2].message = inp.value;
    vsc.postMessage({ type: 'setMessage', index: idx2, message: inp.value });
  }
});

// ---- Keyboard shortcuts on focused rows ----
list.addEventListener('keydown', function(e) {
  if (e.target.closest('.entry-msg-input')) { return; }
  var row = e.target.closest('.entry-row');
  if (!row) { return; }
  var idx = parseInt(row.dataset.idx, 10);
  var nc = nonCommentEntries();
  // Action key shortcuts
  if (ACTION_KEYS[e.key]) {
    e.preventDefault();
    var action = ACTION_KEYS[e.key];
    // squash/fixup are invalid for the first non-drop commit
    var firstActive = nc.findIndex(function(x) { return x.action !== 'drop'; });
    if (idx <= firstActive && (action === 'squash' || action === 'fixup')) { return; }
    nc[idx].action = action;
    render();
    vsc.postMessage({ type: 'setAction', index: idx, action: action });
    // Re-focus after render
    var rows = list.querySelectorAll('.entry-row');
    if (rows[idx]) { rows[idx].focus(); }
    return;
  }
  // Move row up/down with Alt+Up/Down
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    var toIdx = e.key === 'ArrowUp' ? idx - 1 : idx + 1;
    if (toIdx < 0 || toIdx >= nc.length) { return; }
    var moved = nc[idx];
    var target = nc[toIdx];
    var fullMoved = entries.indexOf(moved);
    var fullTarget = entries.indexOf(target);
    entries.splice(fullMoved, 1);
    var ft2 = entries.indexOf(target);
    entries.splice(ft2 + (e.key === 'ArrowDown' ? 1 : 0), 0, moved);
    fixFirstAction();
    // Invalidate combined messages since group composition may have changed after reorder
    nonCommentEntries().forEach(function(x, xi) {
      if (x.combinedMessage !== undefined) {
        x.message = x.origMessage;
        vsc.postMessage({ type: 'setMessage', index: xi, message: x.origMessage });
        delete x.combinedMessage;
      }
    });
    render();
    vsc.postMessage({ type: 'reorder', from: idx, to: toIdx });
    var newRows = list.querySelectorAll('.entry-row');
    if (newRows[toIdx]) { newRows[toIdx].focus(); }
  }
});

// ---- Auto pick → reword on message edit ----
// Typing a new message on a 'pick' line auto-promotes it to 'reword'.
// (reword→pick is handled silently in serializeForSave when message is unchanged)
list.addEventListener('input', function(e) {
  // Combined-message textarea on a squash group head
  var ta = e.target.closest('.combined-msg');
  if (ta) {
    var idx = parseInt(ta.dataset.idx, 10);
    var nc = nonCommentEntries();
    nc[idx].combinedMessage = ta.value;
    ta.rows = Math.max(1, ta.value.split('\\n').length);
    vsc.postMessage({ type: 'setMessage', index: idx, message: ta.value });
    return;
  }
  var inp = e.target.closest('.entry-msg-input');
  if (!inp) { return; }
  var idx = parseInt(inp.dataset.idx, 10);
  var nc = nonCommentEntries();
  var entry = nc[idx];
  var origMsg = entry.origMessage !== undefined ? String(entry.origMessage) : '';
  var row = inp.closest('.entry-row');
  var sel = row && row.querySelector('.action-select');
  // Update local message state so the save path always has the latest value
  entry.message = inp.value;
  vsc.postMessage({ type: 'setMessage', index: idx, message: inp.value });
  if (entry.action === 'pick' && inp.value.trim() !== origMsg.trim()) {
    entry.action = 'reword';
    if (sel) { sel.value = 'reword'; sel.className = 'action-select action-reword'; }
    vsc.postMessage({ type: 'setAction', index: idx, action: 'reword' });
  } else if (entry.action === 'reword' && inp.value.trim() === origMsg.trim()) {
    entry.action = 'pick';
    if (sel) { sel.value = 'pick'; sel.className = 'action-select action-pick'; }
    vsc.postMessage({ type: 'setAction', index: idx, action: 'pick' });
  }
});

// ---- Save / Reset buttons ----
document.getElementById('btn-save').addEventListener('click', function() {
  vsc.postMessage({ type: 'save' });
});
document.getElementById('btn-reset').addEventListener('click', function() {
  vsc.postMessage({ type: 'reset' });
});
document.getElementById('setup-link').addEventListener('click', function() {
  vsc.postMessage({ type: 'configureEditor' });
});

// ---- Message handler (extension → webview) ----
window.addEventListener('message', function(ev) {
  var msg = ev.data;
  if (msg.type === 'update') {
    entries = msg.entries;
    // Don't clobber the DOM (and steal focus) while a message input is being edited
    var active = document.activeElement;
    if (!active || (!active.classList.contains('entry-msg-input') && !active.classList.contains('combined-msg'))) {
      render();
    }
  }
});

// ---- Initial render ----
render();
})();
</script>
</body>
</html>`;
}
