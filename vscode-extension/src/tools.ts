import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';
import { newId, ToolCall, ToolResult } from './agentClient';

// ---------------------------------------------------------------------------
// Types shared with the chat view
// ---------------------------------------------------------------------------

export interface ApprovalRequest {
  id: string;
  kind: 'edit' | 'command';
  title: string; // file path or command line
  viewDiff?: () => Thenable<unknown> | void;
}

export interface ToolUI {
  toolStarted(id: string, label: string): void;
  toolFinished(id: string, ok: boolean): void;
  requestApproval(req: ApprovalRequest): Promise<boolean>;
}

/** Serves the "proposed" side of the native diff editor from memory. */
export class ProposalProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'localcopilot';
  private docs = new Map<string, string>();

  register(relPath: string, content: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: ProposalProvider.scheme, path: '/' + relPath.replace(/^\/+/, '') });
    this.docs.set(uri.toString(), content);
    return uri;
  }

  clear() {
    this.docs.clear();
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? '';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EXCLUDE = '**/{node_modules,.git,.venv,venv,__pycache__,dist,out,build,.next,target}/**';

/** Commands that are never run, even with approval. */
const BLOCKED: RegExp[] = [
  /\bsudo\b/i,
  /\brm\s+-[a-z]*r[a-z]*\s+(\/|~|\*|\.\s*$)/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /:\(\)\s*\{/,
  /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/i,
  /\bformat\s+[a-z]:/i,
  /\bdel\s+\/[sq]\b/i,
  /\brmdir\s+\/s\b/i,
  /\b(shutdown|reboot)\b/i,
];

const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n...[truncated ${s.length - n} chars]` : s);
const toEol = (s: string, crlf: boolean) => s.replace(/\r\n/g, '\n').replace(/\n/g, crlf ? '\r\n' : '\n');
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function workspaceRoot(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error('No folder is open in VS Code.');
  }
  return folder.uri;
}

function resolvePath(rel: string): vscode.Uri {
  const base = workspaceRoot().fsPath;
  const full = path.resolve(base, rel || '.');
  const r = path.relative(base, full);
  if (r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r)) {
    throw new Error(`Path '${rel}' is outside the workspace.`);
  }
  return vscode.Uri.file(full);
}

function relPath(uri: vscode.Uri): string {
  return path.relative(workspaceRoot().fsPath, uri.fsPath).split(path.sep).join('/');
}

/** Small models sometimes use file_path / filename instead of path. */
function pathArg(args: Record<string, any>): string {
  return String(args.path ?? args.file_path ?? args.filename ?? '');
}

function describe(call: ToolCall): string {
  const a = call.args ?? {};
  const main = a.path ?? a.file_path ?? a.command ?? a.query ?? a.glob ?? '';
  return call.name + (main !== '' ? ' ' + String(main).slice(0, 80) : '');
}

// ---------------------------------------------------------------------------
// Tool runner
// ---------------------------------------------------------------------------

export class ToolRunner {
  constructor(
    private readonly ui: ToolUI,
    private readonly proposals: ProposalProvider,
    private readonly output: vscode.OutputChannel
  ) {}

  async executeAll(calls: ToolCall[], signal: AbortSignal): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const call of calls) {
      this.ui.toolStarted(call.id, describe(call));
      const content = signal.aborted ? 'Cancelled by the user.' : await this.execute(call, signal);
      const ok = !content.startsWith('Error') && !content.startsWith('The user rejected') && content !== 'Cancelled by the user.';
      this.ui.toolFinished(call.id, ok);
      results.push({ id: call.id, content });
    }
    return results;
  }

  private async execute(call: ToolCall, signal: AbortSignal): Promise<string> {
    const a = call.args ?? {};
    try {
      switch (call.name) {
        case 'list_directory':
          return await this.listDirectory(pathArg(a) || '.');
        case 'read_file':
          return await this.readFile(pathArg(a), Number(a.start_line) || 1, Number(a.end_line) || 0);
        case 'find_files':
          return await this.findFiles(String(a.glob ?? '**/*'));
        case 'search_text':
          return await this.searchText(String(a.query ?? ''), String(a.glob ?? '**/*'));
        case 'get_diagnostics':
          return this.getDiagnostics(pathArg(a));
        case 'write_file':
        case 'replace_in_file':
          return await this.editFile(call);
        case 'run_command':
          return await this.runCommand(String(a.command ?? ''), signal);
        default:
          return `Error: unknown tool '${call.name}'.`;
      }
    } catch (e: any) {
      return `Error: ${e?.message ?? e}`;
    }
  }

  // ----- read-only tools ----------------------------------------------------

  private async listDirectory(p: string): Promise<string> {
    const entries = await vscode.workspace.fs.readDirectory(resolvePath(p));
    const isDir = (t: vscode.FileType) => (t & vscode.FileType.Directory) !== 0;
    entries.sort(([an, at], [bn, bt]) => (isDir(at) === isDir(bt) ? an.localeCompare(bn) : isDir(at) ? -1 : 1));
    const lines = entries.slice(0, 200).map(([name, type]) => name + (isDir(type) ? '/' : ''));
    return lines.join('\n') || '(empty)';
  }

  private async readFile(p: string, start: number, end: number): Promise<string> {
    if (!p) {
      return 'Error: missing path.';
    }
    const uri = resolvePath(p);
    let text: string;
    try {
      // Goes through the editor, so unsaved changes are included.
      text = (await vscode.workspace.openTextDocument(uri)).getText();
    } catch {
      return `Error: cannot read '${p}' as text (it may not exist or may be binary).`;
    }
    const lines = text.split(/\r?\n/);
    const from = Math.max(1, start);
    const to = end > 0 ? Math.min(lines.length, end) : lines.length;
    const body = lines.slice(from - 1, to).join('\n');
    return trunc(`[${p}: lines ${from}-${to} of ${lines.length}]\n${body}`, 20000);
  }

  private async findFiles(glob: string): Promise<string> {
    const uris = await vscode.workspace.findFiles(glob || '**/*', EXCLUDE, 200);
    return uris.map(relPath).sort().join('\n') || '(no matches)';
  }

  private async searchText(query: string, glob: string): Promise<string> {
    if (!query) {
      return 'Error: empty query.';
    }
    let re: RegExp;
    try {
      re = new RegExp(query, 'i');
    } catch {
      re = new RegExp(escapeRegExp(query), 'i');
    }
    const uris = await vscode.workspace.findFiles(glob || '**/*', EXCLUDE, 2000);
    const hits: string[] = [];
    for (const uri of uris) {
      if (hits.length >= 60) {
        break;
      }
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > 1_000_000) {
          continue;
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (bytes.includes(0)) {
          continue; // binary
        }
        const lines = Buffer.from(bytes).toString('utf8').split(/\r?\n/);
        lines.forEach((line, i) => {
          if (hits.length < 60 && re.test(line)) {
            hits.push(`${relPath(uri)}:${i + 1}: ${line.trim().slice(0, 200)}`);
          }
        });
      } catch {
        // unreadable file: skip
      }
    }
    return hits.join('\n') || '(no matches)';
  }

  private getDiagnostics(p: string): string {
    const severity = ['Error', 'Warning'];
    const entries: [vscode.Uri, vscode.Diagnostic[]][] = p
      ? [[resolvePath(p), vscode.languages.getDiagnostics(resolvePath(p))]]
      : vscode.languages.getDiagnostics();
    const lines: string[] = [];
    for (const [uri, diags] of entries) {
      if (uri.scheme !== 'file' || relPath(uri).startsWith('..')) {
        continue;
      }
      for (const d of diags) {
        if (d.severity <= vscode.DiagnosticSeverity.Warning && lines.length < 50) {
          lines.push(`${relPath(uri)}:${d.range.start.line + 1}:${d.range.start.character + 1} [${severity[d.severity]}] ${d.message}`);
        }
      }
    }
    return lines.join('\n') || 'No errors or warnings.';
  }

  // ----- file edits: diff -> approval -> WorkspaceEdit -> save ---------------

  private async editFile(call: ToolCall): Promise<string> {
    const a = call.args ?? {};
    const p = pathArg(a);
    if (!p) {
      return 'Error: missing path.';
    }
    const uri = resolvePath(p);

    let doc: vscode.TextDocument | undefined;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch {
      doc = undefined;
    }
    const exists = !!doc;
    const crlf = doc?.eol === vscode.EndOfLine.CRLF;
    const oldText = doc?.getText() ?? '';

    let newText: string;
    let partial: { start: number; end: number; text: string } | undefined;

    if (call.name === 'write_file') {
      newText = toEol(String(a.content ?? ''), crlf);
    } else {
      if (!doc) {
        return `Error: file '${p}' does not exist. Use write_file to create it.`;
      }
      const oldStr = toEol(String(a.old_text ?? ''), crlf);
      const newStr = toEol(String(a.new_text ?? ''), crlf);
      if (!oldStr) {
        return 'Error: old_text is empty.';
      }
      const first = oldText.indexOf(oldStr);
      if (first < 0) {
        return 'Error: old_text was not found in the file. Read the file again and copy the text exactly.';
      }
      if (oldText.indexOf(oldStr, first + oldStr.length) >= 0) {
        return 'Error: old_text appears more than once. Include more surrounding lines to make it unique.';
      }
      newText = oldText.slice(0, first) + newStr + oldText.slice(first + oldStr.length);
      partial = { start: first, end: first + oldStr.length, text: newStr };
    }
    if (newText === oldText) {
      return 'No changes needed: the file already has that content.';
    }

    const id = newId();
    const showDiff = async () => {
      const left = exists ? uri : this.proposals.register(`empty/${p}`, '');
      const right = this.proposals.register(`proposed/${id}/${p}`, newText);
      await vscode.commands.executeCommand(
        'vscode.diff',
        left,
        right,
        `${exists ? 'Proposed changes' : 'New file'}: ${p}`,
        { preview: true, preserveFocus: true }
      );
    };
    await showDiff();
    const approved = await this.ui.requestApproval({
      id,
      kind: 'edit',
      title: exists ? p : `${p} (new file)`,
      viewDiff: showDiff,
    });
    await this.closeDiffTabs();
    this.proposals.clear();

    if (!approved) {
      return 'The user rejected this change. Do not retry it; ask what they want instead.';
    }

    const autoSave = vscode.workspace.getConfiguration('localCopilot').get<boolean>('autoSaveAfterApply', true);

    if (doc) {
      const current = (await vscode.workspace.openTextDocument(uri)).getText();
      if (current !== oldText) {
        return 'Error: the file changed while waiting for approval. Read it again and retry.';
      }
      const edit = new vscode.WorkspaceEdit();
      const range = partial
        ? new vscode.Range(doc.positionAt(partial.start), doc.positionAt(partial.end))
        : new vscode.Range(doc.positionAt(0), doc.positionAt(oldText.length));
      edit.replace(uri, range, partial ? partial.text : newText);
      if (!(await vscode.workspace.applyEdit(edit))) {
        return 'Error: VS Code could not apply the edit.';
      }
      if (autoSave) {
        await doc.save();
      }
      void vscode.window.showTextDocument(uri, { preview: true, preserveFocus: true });
      return autoSave ? `Applied the change to ${p} and saved it.` : `Applied the change to ${p} (not saved yet).`;
    }

    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(newText, 'utf8'));
    void vscode.window.showTextDocument(uri, { preview: true, preserveFocus: true });
    return `Created ${p}.`;
  }

  private async closeDiffTabs() {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.scheme === ProposalProvider.scheme) {
          await vscode.window.tabGroups.close(tab);
        }
      }
    }
  }

  // ----- commands: policy -> approval -> run ----------------------------------

  private isSafe(cmd: string): boolean {
    if (/[;&|<>`$()\n]/.test(cmd)) {
      return false;
    }
    const safe = vscode.workspace.getConfiguration('localCopilot').get<string[]>('safeCommands', []);
    return safe.some((s) => cmd === s || cmd.startsWith(s + ' '));
  }

  private async runCommand(raw: string, signal: AbortSignal): Promise<string> {
    const cmd = raw.trim();
    if (!cmd) {
      return 'Error: empty command.';
    }
    if (BLOCKED.some((r) => r.test(cmd))) {
      return 'Error: this command is blocked by the safety policy. Choose a safer way to do it.';
    }
    if (!this.isSafe(cmd)) {
      const approved = await this.ui.requestApproval({ id: newId(), kind: 'command', title: cmd });
      if (!approved) {
        return 'The user rejected this command. Do not retry it; ask what they want instead.';
      }
    }
    return this.exec(cmd, signal);
  }

  private exec(cmd: string, signal: AbortSignal): Promise<string> {
    const seconds = vscode.workspace.getConfiguration('localCopilot').get<number>('commandTimeoutSeconds', 60);
    this.output.show(true);
    this.output.appendLine(`$ ${cmd}`);
    return new Promise((resolve) => {
      let out = '';
      const child = spawn(cmd, { shell: true, cwd: workspaceRoot().fsPath, env: process.env });
      const collect = (d: Buffer) => {
        const s = d.toString();
        out += s;
        this.output.append(s);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const onAbort = () => child.kill();
      signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        out += `\n[killed: timed out after ${seconds}s]`;
        child.kill();
      }, seconds * 1000);
      child.on('close', (code) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.output.appendLine(`[exit code ${code}]\n`);
        const tail = out.length > 6000 ? '...[earlier output truncated]\n' + out.slice(-6000) : out;
        resolve(`exit code: ${code}\n${tail}`);
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(`Error: ${e.message}`);
      });
    });
  }
}
