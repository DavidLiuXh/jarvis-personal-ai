"""
High-Fidelity Financial Advisor A2A Server (V2 Optimized)
Supports stateful multi-turn interactions and complies with A2A SDK V2.
"""
import os
import asyncio
import json
import uuid
from fastapi import FastAPI

# V2 Components based on deep probe
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.agent_execution import RequestContext
from a2a.server.agent_execution.agent_executor import EventQueue
from a2a.server.routes import create_jsonrpc_routes
from a2a.server.tasks import InMemoryTaskStore
from a2a.types import TaskStatus, TaskState, AgentCard

# Import ADK root agent
from financial_advisor.agent import root_agent

class FinancialAdvisorExecutor:
    """
    Executor with Task-level context retention and enhanced question sniffing.
    """
    def __init__(self):
        # Maps taskId -> cumulative conversation text to maintain context
        self.session_histories = {}

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        task_id = context.task_id
        user_input = context.message.text
        
        # 1. Retrieve or initialize context
        if task_id not in self.session_histories:
            self.session_histories[task_id] = ""
            print(f"[financial-advisor] New session started for task {task_id}", flush=True)
        
        current_history = self.session_histories[task_id]
        full_query = f"{current_history}\n\nUser: {user_input}" if current_history else user_input

        print(f"[financial-advisor] Processing turn for {task_id} (History len: {len(current_history)})", flush=True)

        accumulated_text = ""
        try:
            # 2. Run the ADK stream
            async for chunk in root_agent.stream(full_query):
                accumulated_text += chunk
                await event_queue.send_artifact_update(
                    name="output",
                    parts=[{"text": chunk}]
                )

            # 3. Update internal history
            self.session_histories[task_id] = f"{full_query}\n\nAssistant: {accumulated_text}"

            # 4. Enhanced Heuristic: Is the agent asking for input?
            trimmed = accumulated_text.strip()
            
            # Pattern A: Punctuation (English/Chinese)
            ends_with_q = trimmed.endswith('?') or trimmed.endswith('？') or trimmed.endswith(':') or trimmed.endswith('：')
            
            # Pattern B: Explicit Request Keywords
            lower_text = accumulated_text.lower()
            request_keywords = [
                "please provide", "input", "ready to", "tell me", "choose",
                "请输入", "请提供", "告诉我", "回复", "选择", "准备好了吗"
            ]
            has_keyword = any(kw in lower_text for kw in request_keywords)

            if ends_with_q or has_keyword:
                print(f"[financial-advisor] Task {task_id} holds for input", flush=True)
                await event_queue.send_status_update(
                    status=TaskStatus(
                        state=TaskState.TASK_STATE_INPUT_REQUIRED,
                        message={"role": "ROLE_AGENT", "parts": [{"text": "Waiting for user response..."}]}
                    )
                )
            else:
                print(f"[financial-advisor] Task {task_id} COMPLETED", flush=True)
                self.session_histories.pop(task_id, None)
                await event_queue.send_status_update(
                    status=TaskStatus(state=TaskState.TASK_STATE_COMPLETED)
                )
        
        except Exception as e:
            error_msg = f"Analysis Error: {str(e)}"
            print(f"[financial-advisor] Task {task_id} FAILED: {error_msg}", flush=True)
            self.session_histories.pop(task_id, None)
            await event_queue.send_status_update(
                status=TaskStatus(
                    state=TaskState.TASK_STATE_FAILED,
                    message={"role": "ROLE_AGENT", "parts": [{"text": error_msg}]}
                )
            )

def build_app() -> FastAPI:
    app = FastAPI()
    
    # 1. Load Agent Metadata using absolute path relative to this file
    base_dir = os.path.dirname(os.path.abspath(__file__))
    agent_json_path = os.path.join(base_dir, "agent.json")
    
    with open(agent_json_path, "r") as f:
        card_data = json.load(f)
    
    # 2. Instantiate V2 Handler with required stores
    # We use basic initialization for the card; the SDK handles the rest.
    agent_card = AgentCard()
    
    executor = FinancialAdvisorExecutor()
    handler = DefaultRequestHandler(
        agent_executor=executor,
        task_store=InMemoryTaskStore(),
        agent_card=agent_card
    )
    
    app.include_router(create_jsonrpc_routes(handler, "/"))
    
    @app.get("/.well-known/agent-card.json")
    async def get_card():
        return card_data
            
    return app

if __name__ == "__main__":
    import uvicorn
    PORT = int(os.environ.get("JARVIS_AGENT_PORT", 8000))
    print(f"[financial-advisor] Booting Interactive A2A V2 Server on port {PORT}", flush=True)
    app = build_app()
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
EOF
