import * as vscode from 'vscode';

export type ToolCall = { id: string; name: string; args: Record<string, any> };
export type ToolResult = { id: string; content: string };

type ServerEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_request'; calls: ToolCall[] }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface RunHandlers {
  onToken(text: string): void;
  executeTools(calls: ToolCall[], signal: AbortSignal): Promise<ToolResult[]>;
}

export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export function serverUrl(): string {
  return vscode.workspace
    .getConfiguration('localCopilot')
    .get<string>('serverUrl', 'http://127.0.0.1:8765')
    .replace(/\/+$/, '');
}

export class AgentClient {
  threadId = newId();

  newThread() {
    this.threadId = newId();
  }

  /**
   * Send a message, then keep looping: whenever the backend asks for tool calls,
   * run them in the editor and POST the results to /resume, until the backend is done.
   */
  async run(message: string, context: unknown, handlers: RunHandlers, signal: AbortSignal): Promise<void> {
    let request: { path: string; body: unknown } = {
      path: '/chat',
      body: { thread_id: this.threadId, message, context },
    };
    while (true) {
      const calls = await this.stream(request.path, request.body, handlers, signal);
      if (!calls) {
        return;
      }
      const results = await handlers.executeTools(calls, signal);
      request = { path: '/resume', body: { thread_id: this.threadId, results } };
    }
  }

  private async stream(
    path: string,
    body: unknown,
    handlers: RunHandlers,
    signal: AbortSignal
  ): Promise<ToolCall[] | undefined> {
    const res = await fetch(serverUrl() + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`Server returned ${res.status}: ${await res.text()}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let pending: ToolCall[] | undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const line = raw.split('\n').find((l) => l.startsWith('data: '));
        if (!line) {
          continue;
        }
        const ev = JSON.parse(line.slice(6)) as ServerEvent;
        if (ev.type === 'token') {
          handlers.onToken(ev.text);
        } else if (ev.type === 'tool_request') {
          pending = ev.calls;
        } else if (ev.type === 'error') {
          throw new Error(ev.message);
        }
      }
    }
    return pending;
  }
}
