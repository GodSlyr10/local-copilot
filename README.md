# Local Copilot: LangGraph + Ollama + VS Code

A Copilot-style assistant that runs on a local Ollama model.

```
VS Code extension (TypeScript)  <--SSE/HTTP-->  Python backend (FastAPI + LangGraph)  <-->  Ollama
  chat panel, diffs, approvals                    agent loop, tool schemas                   qwen2.5:3b
  executes ALL tools in the editor                never touches your files
```

The backend decides which tool to call. Every tool call goes back to the extension, which runs it
inside VS Code: reads see unsaved buffers, edits show a native diff and need your approval, commands
need approval, and edits are applied with `WorkspaceEdit` so Ctrl+Z works.

## 1. Backend
```bash
cd backend
pip install -r requirements.txt        # Python 3.11+ recommended
ollama pull qwen2.5:3b
python server.py                       # http://127.0.0.1:8765 (localhost only)
```
Optional environment variables: `AGENT_MODEL` (default `qwen2.5:3b`), `NUM_CTX` (8192),
`COMPLETION_MODEL` (`qwen2.5-coder:1.5b`), `PORT` (8765).

## 2. Extension
```bash
cd vscode-extension
rm -rf node_modules out package-lock.json   # clear any leftovers first
npm install
npm run compile
```
Open the `vscode-extension` folder in VS Code and press **F5**. In the new window, open one of your
projects and click the Local Copilot icon in the activity bar.

Permanent install: `npm run package`, then "Extensions: Install from VSIX...".

## Using it
- Chat normally, or use `/explain`, `/fix`, `/tests`, `/doc` (they use your current selection).
  The same actions are in the right-click menu when text is selected.
- Every file change shows a diff plus Apply/Reject. Every command asks first.
- Settings (search "Local Copilot"): server URL, safe-command allowlist, command timeout,
  auto-save after apply, inline completions.
- Inline ghost-text completions are off by default. Run `ollama pull qwen2.5-coder:1.5b`, then enable
  `localCopilot.inlineCompletions.enabled`.