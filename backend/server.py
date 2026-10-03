"""
Local Copilot backend (FastAPI).

POST /chat      start/continue a conversation  -> SSE stream
POST /resume    send tool results back          -> SSE stream
POST /complete  inline code completion (FIM)    -> JSON
GET  /health

SSE events (one JSON object per `data:` line):
  {"type": "token", "text": "..."}                       streamed assistant text
  {"type": "tool_request", "calls": [{id, name, args}]}  extension must run these, then POST /resume
  {"type": "done"}
  {"type": "error", "message": "..."}

Run:  python server.py        (listens on 127.0.0.1:8765 only)
"""

import json
import os

from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from langgraph.types import Command
from ollama import AsyncClient
from pydantic import BaseModel

from agent import MODEL, build_graph, build_user_message

COMPLETION_MODEL = os.getenv("COMPLETION_MODEL", "qwen2.5-coder:1.5b")
HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8765"))

app = FastAPI(title="Local Copilot server")
graph = build_graph()


class ChatRequest(BaseModel):
    thread_id: str
    message: str
    context: dict = {}


class ToolResult(BaseModel):
    id: str
    content: str


class ResumeRequest(BaseModel):
    thread_id: str
    results: list[ToolResult]


class CompleteRequest(BaseModel):
    prefix: str
    suffix: str = ""
    language: str = ""
    filename: str = ""


def sse(event: dict) -> str:
    return f"data: {json.dumps(event)}\n\n"


class TokenGate:
    """Streams assistant text to the editor, but holds back a message that looks like a
    raw JSON / <tool_call> blob (a small model failing to call a tool properly), so the
    user never sees it. agent.salvage_tool_calls() turns such blobs into real tool calls."""

    HOLD = ("{", "<tool_call")

    def __init__(self):
        self.reset()

    def reset(self):
        self.mode = None  # None = undecided, "pass", "hold"
        self.buf = ""

    @property
    def held(self) -> bool:
        return self.mode == "hold"

    def feed(self, chunk) -> str:
        text = chunk.content if isinstance(getattr(chunk, "content", ""), str) else ""
        if self.mode == "pass":
            return text
        if self.mode == "hold":
            return ""
        self.buf += text
        s = self.buf.lstrip()
        if not s:
            return ""
        if s.startswith(self.HOLD):
            self.mode = "hold"
            return ""
        if any(h.startswith(s) for h in self.HOLD):
            return ""  # could still turn into a tool-call blob; keep buffering
        self.mode = "pass"
        out, self.buf = self.buf, ""
        return out


async def event_stream(payload, thread_id: str):
    config = {"configurable": {"thread_id": thread_id}, "recursion_limit": 60}
    gate = TokenGate()
    try:
        async for mode, data in graph.astream(payload, config, stream_mode=["messages", "updates"]):
            if mode == "messages":
                chunk, meta = data
                if meta.get("langgraph_node") == "agent":
                    text = gate.feed(chunk)
                    if text:
                        yield sse({"type": "token", "text": text})
            elif "__interrupt__" in data:
                yield sse({"type": "tool_request", "calls": data["__interrupt__"][0].value["calls"]})
                return
            elif "agent" in data:
                msg = data["agent"]["messages"][-1]
                if gate.held and not msg.tool_calls and msg.content:
                    yield sse({"type": "token", "text": msg.content})  # held text was not a tool call after all
                gate.reset()
        yield sse({"type": "done"})
    except Exception as e:  # surface model / connection errors in the chat
        yield sse({"type": "error", "message": f"{type(e).__name__}: {e}"})


def stream_response(payload, thread_id: str) -> StreamingResponse:
    return StreamingResponse(
        event_stream(payload, thread_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL, "completion_model": COMPLETION_MODEL}


@app.post("/chat")
async def chat(req: ChatRequest):
    payload = {"messages": [build_user_message(req.message, req.context)]}
    return stream_response(payload, req.thread_id)


@app.post("/resume")
async def resume(req: ResumeRequest):
    return stream_response(Command(resume=[r.model_dump() for r in req.results]), req.thread_id)


@app.post("/complete")
async def complete(req: CompleteRequest):
    """Fill-in-the-middle completion. Needs a FIM-capable model such as qwen2.5-coder."""
    try:
        res = await AsyncClient().generate(
            model=COMPLETION_MODEL,
            prompt=req.prefix[-3000:],
            suffix=req.suffix[:1000],
            options={"temperature": 0.1, "num_predict": 96, "stop": ["\n\n"]},
            keep_alive="30m",
        )
        return {"completion": res["response"]}
    except Exception as e:
        return {"completion": "", "error": str(e)}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT)
