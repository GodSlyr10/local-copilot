import * as vscode from 'vscode';
import * as path from 'path';
import { serverUrl } from './agentClient';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function registerInlineCompletions(context: vscode.ExtensionContext) {
  const provider: vscode.InlineCompletionItemProvider = {
    async provideInlineCompletionItems(document, position, ictx, token) {
      const cfg = vscode.workspace.getConfiguration('localCopilot');
      if (!cfg.get<boolean>('inlineCompletions.enabled', false)) {
        return undefined;
      }
      if (document.uri.scheme !== 'file' || ictx.selectedCompletionInfo) {
        return undefined;
      }

      await sleep(cfg.get<number>('inlineCompletions.debounceMs', 350));
      if (token.isCancellationRequested) {
        return undefined;
      }

      const prefix = document.getText(
        document.validateRange(new vscode.Range(new vscode.Position(Math.max(0, position.line - 200), 0), position))
      );
      const suffix = document.getText(
        document.validateRange(new vscode.Range(position, new vscode.Position(position.line + 60, 10_000)))
      );

      const ac = new AbortController();
      token.onCancellationRequested(() => ac.abort());
      try {
        const res = await fetch(serverUrl() + '/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prefix,
            suffix,
            language: document.languageId,
            filename: path.basename(document.fileName),
          }),
          signal: ac.signal,
        });
        const data = (await res.json()) as { completion?: string };
        const text = (data.completion ?? '').replace(/\s+$/, '');
        if (!text || token.isCancellationRequested) {
          return undefined;
        }
        return [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))];
      } catch {
        return undefined; // server down or request cancelled: stay silent
      }
    },
  };

  context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider));
}
