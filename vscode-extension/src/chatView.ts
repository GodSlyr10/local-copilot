import * as vscode from 'vscode';
import { AgentClient, serverUrl } from './agentClient';
import { ApprovalRequest, ProposalProvider, ToolRunner, ToolUI } from './tools';

const SLASH: Record<string, string> = {
  '/explain': 'Explain the selected code (or the active file if nothing is selected) clearly and step by step.',
  '/fix':
    'Find and fix the problems in the selected code (or the active file). Check get_diagnostics for errors first, then apply the fix with replace_in_file.',
  '/tests':
    "Write unit tests for the selected code (or the active file) using the project's existing test framework. Create the test file with write_file, then run the tests.",
  '/doc': 'Add clear docstrings / doc comments to the selected code (or the active file) using replace_in_file.',
};

function expandSlash(text: string): string {
  const m = text.match(/^(\/\w+)\s*([\s\S]*)$/);
  if (m && SLASH[m[1]]) {
    return SLASH[m[1]] + (m[2] ? ' ' + m[2] : '');
  }
  return text;
}

function gatherContext(editor: vscode.TextEditor | undefined) {
  const ctx: Record<string, unknown> = { workspace: vscode.workspace.workspaceFolders?.[0]?.name };
  if (editor && !editor.document.isClosed && editor.document.uri.scheme === 'file') {
    const doc = editor.document;
    ctx.activeFile = vscode.workspace.asRelativePath(doc.uri, false);
    ctx.language = doc.languageId;
    if (!editor.selection.isEmpty) {
      ctx.selection = doc.getText(editor.selection).slice(0, 8000);
      ctx.selectionRange = [editor.selection.start.line + 1, editor.selection.end.line + 1];
    } else {
      ctx.cursorLine = editor.selection.active.line + 1;
    }
    ctx.diagnostics = vscode.languages
      .getDiagnostics(doc.uri)
      .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning)
      .slice(0, 10)
      .map((d) => `line ${d.range.start.line + 1}: ${d.message}`);
  }
  ctx.openFiles = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .map((t) => (t.input instanceof vscode.TabInputText ? vscode.workspace.asRelativePath(t.input.uri, false) : ''))
    .filter(Boolean)
    .slice(0, 15);
  return ctx;
}

function friendlyError(e: any): string {
  const msg = String(e?.message ?? e);
  if (msg.includes('fetch failed') || e?.cause?.code === 'ECONNREFUSED') {
    return `Cannot reach the Local Copilot server at ${serverUrl()}.\nStart it with:  cd backend && python server.py\n(and make sure Ollama is running)`;
  }
  return msg;
}

export class ChatViewProvider implements vscode.WebviewViewProvider, ToolUI {
  private view?: vscode.WebviewView;
  private ready!: Promise<void>;
  private markReady!: () => void;
  private abort?: AbortController;
  private approvals = new Map<string, { resolve: (v: boolean) => void; viewDiff?: ApprovalRequest['viewDiff'] }>();
  private readonly client = new AgentClient();
  private readonly tools: ToolRunner;

  constructor(
    private readonly extensionUri: vscode.Uri,
    output: vscode.OutputChannel,
    proposals: ProposalProvider,
    private readonly getEditor: () => vscode.TextEditor | undefined
  ) {
    this.tools = new ToolRunner(this, proposals, output);
    this.resetReady();
  }

  private resetReady() {
    this.ready = new Promise<void>((r) => (this.markReady = r));
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    this.resetReady();
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });
  }

  // ----- public API used by commands -----------------------------------------

  async ask(text: string) {
    await vscode.commands.executeCommand('localCopilot.chat.focus');
    await this.ready;
    await this.send(text);
  }

  newChat() {
    this.stop();
    this.client.newThread();
    void this.post({ type: 'clear' });
  }

  // ----- ToolUI ----------------------------------------------------------------

  toolStarted(id: string, label: string) {
    void this.post({ type: 'tool', id, label });
  }

  toolFinished(id: string, ok: boolean) {
    void this.post({ type: 'toolDone', id, ok });
  }

  requestApproval(req: ApprovalRequest): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.approvals.set(req.id, { resolve, viewDiff: req.viewDiff });
      void this.post({
        type: 'approval',
        id: req.id,
        kind: req.kind,
        title: req.title,
        canViewDiff: !!req.viewDiff,
      });
      this.view?.show?.(true);
    });
  }

  // ----- internals ----------------------------------------------------------------

  private async post(message: unknown) {
    await this.ready;
    await this.view?.webview.postMessage(message);
  }

  private onMessage(m: any) {
    switch (m.type) {
      case 'ready':
        this.markReady();
        break;
      case 'send':
        void this.send(String(m.text ?? ''));
        break;
      case 'stop':
        this.stop();
        break;
      case 'newChat':
        this.newChat();
        break;
      case 'approval': {
        const a = this.approvals.get(m.id);
        if (a) {
          this.approvals.delete(m.id);
          a.resolve(!!m.approved);
        }
        break;
      }
      case 'viewDiff':
        void this.approvals.get(m.id)?.viewDiff?.();
        break;
    }
  }

  private stop() {
    this.abort?.abort();
    for (const [id, a] of this.approvals) {
      a.resolve(false);
      void this.post({ type: 'approvalClosed', id });
    }
    this.approvals.clear();
  }

  private async send(rawText: string) {
    const typed = rawText.trim();
    if (!typed || this.abort) {
      return;
    }
    const ctx = gatherContext(this.getEditor());
    const ac = new AbortController();
    this.abort = ac;
    void this.post({ type: 'user', text: typed });
    void this.post({ type: 'busy', value: true });
    try {
      await this.client.run(
        expandSlash(typed),
        ctx,
        {
          onToken: (text) => void this.post({ type: 'token', text }),
          executeTools: (calls, signal) => this.tools.executeAll(calls, signal),
        },
        ac.signal
      );
    } catch (e: any) {
      if (ac.signal.aborted) {
        void this.post({ type: 'notice', text: 'Stopped.' });
      } else {
        void this.post({ type: 'error', text: friendlyError(e) });
      }
    } finally {
      this.abort = undefined;
      void this.post({ type: 'busy', value: false });
    }
  }

  private html(webview: vscode.Webview): string {
    const asset = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', f));
    const nonce = Array.from({ length: 24 }, () => Math.random().toString(36)[2]).join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${asset('main.css')}" rel="stylesheet">
</head>
<body>
  <div id="log"></div>
  <div id="composer">
    <textarea id="input" rows="3" placeholder="Ask anything, or try /explain /fix /tests /doc"></textarea>
    <div id="buttons">
      <button id="send" class="primary">Send</button>
      <button id="stop" class="secondary" style="display:none">Stop</button>
    </div>
  </div>
  <script nonce="${nonce}" src="${asset('main.js')}"></script>
</body>
</html>`;
  }
}
