"""
LangGraph agent for the Local Copilot VS Code extension.

The agent never touches the filesystem itself. Every tool call is sent to the
VS Code extension (via LangGraph's interrupt()), which executes it inside the
editor: it sees unsaved buffers, shows diffs, asks the user for approval and
applies edits with WorkspaceEdit (so Ctrl+Z works).

Graph:  START -> agent -> client_tools -> agent -> ... -> END
"""

import json
import os
import re
import uuid
from typing import Annotated, TypedDict

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool
from langchain_ollama import ChatOllama
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.types import interrupt

MODEL = os.getenv("AGENT_MODEL", "qwen2.5:3b")
NUM_CTX = int(os.getenv("NUM_CTX", "8192"))
CONTEXT_CHAR_BUDGET = int(os.getenv("CONTEXT_CHAR_BUDGET", "20000"))  # history sent to the LLM
MAX_TOOL_RESULT_CHARS = 20000

SYSTEM_PROMPT = """You are Local Copilot, an AI pair programmer running inside VS Code.
You help the user understand, write, fix, test and document code in their open workspace.

Tools: list_directory, find_files, search_text, read_file, get_diagnostics, write_file, replace_in_file, run_command.
- All paths are relative to the workspace root.
- The user message may end with an [Editor context] block (active file, selection, problems). Use it: "this", "here" and "the selected code" refer to it.
- Read a file before you change it. Use search_text / find_files to locate code instead of guessing.
- Prefer replace_in_file for small edits (copy old_text exactly from the file). Use write_file for new files.
- The user reviews and approves every file change and every command, so just call the tool. Do not paste whole files into the chat to ask for permission.
- After changing code, run the project's tests or build with run_command when that makes sense.
- Call one tool at a time. If the user rejects an action, do not retry it; ask what they want instead.
- Be concise. Put code in fenced markdown blocks with a language tag."""


# ----------------------------------------------------------------------------
# Tool schemas (bodies are never executed here; the extension runs them)
# ----------------------------------------------------------------------------

def _remote():
    raise NotImplementedError("This tool is executed by the VS Code extension.")


@tool
def list_directory(path: str = ".") -> str:
    """List files and folders in a workspace directory (path relative to the workspace root)."""
    return _remote()


@tool
def read_file(path: str, start_line: int = 0, end_line: int = 0) -> str:
    """Read a text file. Optionally pass start_line and end_line (1-based) to read only part of it."""
    return _remote()


@tool
def find_files(glob: str = "**/*") -> str:
    """Find files in the workspace by glob pattern, for example '**/*.py'."""
    return _remote()


@tool
def search_text(query: str, glob: str = "**/*") -> str:
    """Search file contents for a text or regex query. Returns matching lines as path:line: text."""
    return _remote()


@tool
def get_diagnostics(path: str = "") -> str:
    """Get compiler/linter errors and warnings (the Problems panel) for one file, or the whole workspace if path is empty."""
    return _remote()


@tool
def write_file(path: str, content: str) -> str:
    """Create a new file or completely overwrite an existing one. The user reviews a diff before it is saved."""
    return _remote()


@tool
def replace_in_file(path: str, old_text: str, new_text: str) -> str:
    """Replace one exact occurrence of old_text with new_text in an existing file. The user reviews a diff first."""
    return _remote()


@tool
def run_command(command: str) -> str:
    """Run a shell command in the workspace root and return its output. The user must approve it first."""
    return _remote()


TOOLS = [list_directory, read_file, find_files, search_text, get_diagnostics,
         write_file, replace_in_file, run_command]
TOOL_NAMES = {t.name for t in TOOLS}


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------

def build_user_message(text: str, ctx: dict) -> HumanMessage:
    """Attach the editor context (active file, selection, problems) to the user's message."""
    lines = []
    lang = ctx.get("language", "")
    if ctx.get("activeFile"):
        lines.append(f"Active file: {ctx['activeFile']} ({lang or '?'})")
    if ctx.get("selection"):
        a, b = ctx.get("selectionRange", ["?", "?"])
        lines.append(f"Selected lines {a}-{b}:\n```{lang}\n{ctx['selection'][:8000]}\n```")
    elif ctx.get("cursorLine"):
        lines.append(f"Cursor at line {ctx['cursorLine']}")
    if ctx.get("diagnostics"):
        lines.append("Problems in the active file:\n" + "\n".join(f"- {d}" for d in ctx["diagnostics"][:10]))
    if ctx.get("openFiles"):
        lines.append("Open files: " + ", ".join(ctx["openFiles"][:15]))
    if not lines:
        return HumanMessage(text)
    return HumanMessage(text + "\n\n[Editor context]\n" + "\n".join(lines))


def repair_history(messages: list) -> list:
    """If a run was cancelled while tool calls were pending, add placeholder results
    so the history stays valid for the LLM."""
    answered = {m.tool_call_id for m in messages if isinstance(m, ToolMessage)}
    out = []
    for m in messages:
        out.append(m)
        if isinstance(m, AIMessage):
            for c in m.tool_calls:
                if c["id"] not in answered:
                    out.append(ToolMessage(content="Cancelled by the user.", tool_call_id=c["id"], name=c["name"]))
    return out


def fit_context(messages: list, budget: int = CONTEXT_CHAR_BUDGET) -> list:
    """Keep the newest turn always, and add older turns while they fit the budget.
    A turn starts at a HumanMessage, so tool calls and their results are never split."""
    turns, cur = [], []
    for m in messages:
        if isinstance(m, HumanMessage) and cur:
            turns.append(cur)
            cur = []
        cur.append(m)
    if cur:
        turns.append(cur)
    kept, used = [], 0
    for turn in reversed(turns):
        size = sum(len(str(m.content)) for m in turn)
        if kept and used + size > budget:
            break
        kept.insert(0, turn)
        used += size
    return [m for t in kept for m in t]


def salvage_tool_calls(msg: AIMessage) -> AIMessage:
    """Small models sometimes write the tool call as JSON text instead of a real
    tool call. Detect that and convert it."""
    if msg.tool_calls or not isinstance(msg.content, str):
        return msg
    text = re.sub(r"</?tool_call>", "", msg.content).strip()
    text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.M).strip()
    if not text.startswith(("{", "[")):
        return msg
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return msg
    calls = []
    for item in data if isinstance(data, list) else [data]:
        if not isinstance(item, dict) or item.get("name") not in TOOL_NAMES:
            continue
        args = item.get("arguments", item.get("parameters", {}))
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except json.JSONDecodeError:
                continue
        if isinstance(args, dict):
            calls.append({"name": item["name"], "args": args,
                          "id": f"call_{uuid.uuid4().hex[:8]}", "type": "tool_call"})
    if not calls:
        return msg
    return AIMessage(content="", tool_calls=calls, id=msg.id)


# ----------------------------------------------------------------------------
# Graph
# ----------------------------------------------------------------------------

class State(TypedDict):
    messages: Annotated[list, add_messages]


llm = ChatOllama(model=MODEL, temperature=0, num_ctx=NUM_CTX, keep_alive="30m").bind_tools(TOOLS)


async def agent_node(state: State, config):
    history = fit_context(repair_history(state["messages"]))
    response = await llm.ainvoke([SystemMessage(SYSTEM_PROMPT)] + history, config)
    return {"messages": [salvage_tool_calls(response)]}


async def client_tools_node(state: State):
    """Hand the tool calls to the VS Code extension and wait for the results.
    This node has no side effects, so LangGraph can safely re-run it on resume."""
    calls = state["messages"][-1].tool_calls
    results = interrupt({"calls": [{"id": c["id"], "name": c["name"], "args": c["args"]} for c in calls]})
    by_id = {r["id"]: r["content"] for r in results}
    messages = []
    for c in calls:
        content = str(by_id.get(c["id"], "Error: the editor returned no result for this tool call."))
        if len(content) > MAX_TOOL_RESULT_CHARS:
            content = content[:MAX_TOOL_RESULT_CHARS] + "\n...[truncated]"
        messages.append(ToolMessage(content=content, tool_call_id=c["id"], name=c["name"]))
    return {"messages": messages}


def route_after_agent(state: State):
    return "client_tools" if getattr(state["messages"][-1], "tool_calls", None) else END


def build_graph():
    g = StateGraph(State)
    g.add_node("agent", agent_node)
    g.add_node("client_tools", client_tools_node)
    g.add_edge(START, "agent")
    g.add_conditional_edges("agent", route_after_agent, ["client_tools", END])
    g.add_edge("client_tools", "agent")
    return g.compile(checkpointer=MemorySaver())  # a checkpointer is required for interrupt()
