import * as vscode from 'vscode';
import { ChatViewProvider } from './chatView';
import { registerInlineCompletions } from './inline';
import { ProposalProvider } from './tools';

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Local Copilot');
  const proposals = new ProposalProvider();

  // The chat webview takes focus, so remember the last real text editor to know
  // which file / selection the user is talking about.
  let lastEditor: vscode.TextEditor | undefined = vscode.window.activeTextEditor;
  const getEditor = () => {
    const active = vscode.window.activeTextEditor;
    if (active && active.document.uri.scheme === 'file') {
      return active;
    }
    return lastEditor && !lastEditor.document.isClosed ? lastEditor : undefined;
  };

  const chat = new ChatViewProvider(context.extensionUri, output, proposals, getEditor);

  context.subscriptions.push(
    output,
    vscode.workspace.registerTextDocumentContentProvider(ProposalProvider.scheme, proposals),
    vscode.window.registerWebviewViewProvider('localCopilot.chat', chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.onDidChangeActiveTextEditor((e) => {
      if (e && e.document.uri.scheme === 'file') {
        lastEditor = e;
      }
    }),
    vscode.commands.registerCommand('localCopilot.newChat', () => chat.newChat()),
    vscode.commands.registerCommand('localCopilot.explain', () => chat.ask('/explain')),
    vscode.commands.registerCommand('localCopilot.fix', () => chat.ask('/fix')),
    vscode.commands.registerCommand('localCopilot.tests', () => chat.ask('/tests')),
    vscode.commands.registerCommand('localCopilot.doc', () => chat.ask('/doc'))
  );

  registerInlineCompletions(context);
}

export function deactivate() {}
