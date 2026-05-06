"""
Native A2A Server for Financial Advisor
One-Shot Execution mode. Bypasses multi-turn complexities for maximum stability.
"""
import os
import asyncio
import json
import uuid
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from google import genai
from google.genai import types

from financial_advisor.prompt import FINANCIAL_COORDINATOR_PROMPT

import sys

app = FastAPI()

# Fail-fast on startup — avoids accepting tasks that will silently fail later
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
if not GEMINI_API_KEY:
    print("[financial-advisor] FATAL: GEMINI_API_KEY (or GOOGLE_API_KEY) is not set",
          flush=True, file=sys.stderr)
    sys.exit(1)

async def event_generator(task_id: str, user_input: str):
    """Generates Server-Sent Events conforming to A2A V1/V2 protocol in One-Shot mode."""
    
    print(f"[financial-advisor] Processing One-Shot turn for task {task_id}", flush=True)
    print(f"[financial-advisor] Extracted Payload: {user_input}", flush=True)

    try:
        client = genai.Client(api_key=GEMINI_API_KEY)
        
        # 1. Inform Jarvis that we are working
        working_event = {
            "jsonrpc": "2.0",
            "id": task_id,
            "result": {
                "statusUpdate": {
                    "status": {
                        "state": "TASK_STATE_WORKING",
                        "message": {"parts": [{"text": "正在进行全维度理财规划分析..."}]}
                    }
                }
            }
        }
        yield f"data: {json.dumps(working_event)}\n\n"

        # 2. Stream from GenAI asynchronously
        def get_stream():
            return client.models.generate_content_stream(
                model="gemini-2.5-pro",
                contents=user_input,
                config=types.GenerateContentConfig(
                    system_instruction=FINANCIAL_COORDINATOR_PROMPT,
                    temperature=0.2,
                )
            )
            
        response_stream = await asyncio.to_thread(get_stream)
        
        for chunk in response_stream:
            if chunk.text:
                # Yield artifactUpdate for each chunk
                event = {
                    "jsonrpc": "2.0",
                    "id": task_id,
                    "result": {
                        "artifactUpdate": {
                            "artifact": {
                                "parts": [{"text": chunk.text}]
                            }
                        }
                    }
                }
                yield f"data: {json.dumps(event)}\n\n"

        # 3. Direct to COMPLETED (No Heuristics, No Wait)
        print(f"[financial-advisor] Task {task_id} COMPLETED.", flush=True)
        comp_event = {
            "jsonrpc": "2.0",
            "id": task_id,
            "result": {
                "statusUpdate": {
                    "status": {"state": "TASK_STATE_COMPLETED"}
                }
            }
        }
        yield f"data: {json.dumps(comp_event)}\n\n"
        
        # Final SSE termination signal
        yield "data: [DONE]\n\n"
            
    except Exception as e:
        error_msg = f"Analysis Error: {str(e)}"
        print(f"[financial-advisor] Task {task_id} FAILED: {error_msg}", flush=True)
        err_event = {
            "jsonrpc": "2.0",
            "id": task_id,
            "result": {
                "statusUpdate": {
                    "status": {
                        "state": "TASK_STATE_FAILED",
                        "message": {"parts": [{"text": error_msg}]}
                    }
                }
            }
        }
        yield f"data: {json.dumps(err_event)}\n\n"
        yield "data: [DONE]\n\n"


@app.post("/")
async def handle_jsonrpc(request: Request):
    """Native JSON-RPC interceptor."""
    data = await request.json()
    
    params = data.get("params", {})
    message = params.get("message", {})
    parts = message.get("parts", [])
    
    # agentLauncher sends task ID in the JSON-RPC "id" field (not message.task_id)
    task_id = data.get("id") or str(uuid.uuid4())
    
    user_input = ""
    for p in parts:
        if "text" in p:
            user_input += p["text"]

    # No need to meticulously normalize anymore, we just pass the JSON 
    # directly to the model as context (e.g. '{"ticker": "NVDA", "risk_attitude": "稳健"}')
    # The prompt handles it perfectly.

    return StreamingResponse(
        event_generator(task_id, user_input),
        media_type="text/event-stream"
    )

@app.get("/.well-known/agent-card.json")
async def get_card():
    """Health check & Metadata endpoint."""
    base_dir = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(base_dir, "agent.json"), "r") as f:
        return json.load(f)

if __name__ == "__main__":
    import uvicorn
    PORT = int(os.environ.get("JARVIS_AGENT_PORT", 8000))
    print(f"[financial-advisor] Booting NATIVE One-Shot Server on port {PORT}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
