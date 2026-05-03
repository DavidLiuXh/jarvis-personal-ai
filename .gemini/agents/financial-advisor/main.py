"""
Financial Advisor ADK Agent
Uses robust direct genai execution to bypass all experimental ADK constraints.
"""
import os
import sys
import json
import uvicorn
from starlette.applications import Starlette
from google import genai
from google.genai import types

from a2a.helpers import (
    new_task_from_user_message,
    new_text_artifact,
    new_text_message,
)
from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes
from a2a.server.tasks import InMemoryTaskStore
from a2a.types import (
    AgentCapabilities,
    AgentCard,
    AgentInterface,
    AgentSkill,
)
from a2a.types.a2a_pb2 import (
    TaskArtifactUpdateEvent,
    TaskState,
    TaskStatus,
    TaskStatusUpdateEvent,
)

# Extract just the prompt, drop the problematic agent wrapper
from financial_advisor.prompt import FINANCIAL_COORDINATOR_PROMPT

PORT = int(os.environ.get("JARVIS_AGENT_PORT", 8000))
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")

class FinancialAdvisorExecutor(AgentExecutor):
    def __init__(self):
        super().__init__()
        self.client = genai.Client(api_key=GEMINI_API_KEY)
        self.chats = {}

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        task = context.current_task or new_task_from_user_message(context.message)
        await event_queue.enqueue_event(task)

        task_id = context.task_id
        
        user_input = ""
        for part in (context.message.parts or []):
            if hasattr(part, "text") and part.text:
                user_input = part.text
                break
                
        try:
            parsed = json.loads(user_input)
            if isinstance(parsed, dict) and "initial_query" in parsed:
                user_input = parsed["initial_query"]
            elif isinstance(parsed, dict) and "query" in parsed:
                user_input = parsed["query"]
        except:
            pass

        if task_id not in self.chats:
            print(f"[financial-advisor] New genai chat session started for task {task_id}", flush=True)
            # Initialize a robust genai Chat session with the master prompt
            self.chats[task_id] = self.client.chats.create(
                model="gemini-2.5-pro",
                config=types.GenerateContentConfig(
                    system_instruction=FINANCIAL_COORDINATOR_PROMPT,
                    temperature=0.2,
                )
            )
            
        chat = self.chats[task_id]
        print(f"[financial-advisor] Processing turn for {task_id}", flush=True)

        accumulated_text = ""
        try:
            # Safe asynchronous streaming using pure genai client
            # asyncio.to_thread bridges the sync generator to async context safely
            import asyncio
            
            def get_stream():
                return chat.send_message_stream(user_input)
                
            response_stream = await asyncio.to_thread(get_stream)
            
            for chunk in response_stream:
                if chunk.text:
                    accumulated_text += chunk.text
                    await event_queue.enqueue_event(
                        TaskArtifactUpdateEvent(
                            task_id=context.task_id,
                            context_id=context.context_id,
                            artifact=new_text_artifact(name="output", text=chunk.text),
                        )
                    )

            trimmed = accumulated_text.strip()
            ends_with_q = trimmed.endswith('?') or trimmed.endswith('？') or trimmed.endswith(':') or trimmed.endswith('：')
            
            lower_text = accumulated_text.lower()
            request_keywords = [
                "please provide", "input", "ready to", "tell me", "choose",
                "请输入", "请提供", "告诉我", "回复", "选择", "准备好了吗", "ready to get started"
            ]
            has_keyword = any(kw in lower_text for kw in request_keywords)

            if ends_with_q or has_keyword:
                print(f"[financial-advisor] Task {task_id} holds for input", flush=True)
                await event_queue.enqueue_event(
                    TaskStatusUpdateEvent(
                        task_id=context.task_id,
                        context_id=context.context_id,
                        status=TaskStatus(
                            state=TaskState.TASK_STATE_INPUT_REQUIRED,
                            message=new_text_message("Waiting for your response..."),
                        ),
                    )
                )
            else:
                print(f"[financial-advisor] Task {task_id} COMPLETED", flush=True)
                self.chats.pop(task_id, None)
                await event_queue.enqueue_event(
                    TaskStatusUpdateEvent(
                        task_id=context.task_id,
                        context_id=context.context_id,
                        status=TaskStatus(state=TaskState.TASK_STATE_COMPLETED),
                    )
                )
                
        except Exception as e:
            error_msg = f"Analysis Error: {str(e)}"
            print(f"[financial-advisor] Task {task_id} FAILED: {error_msg}", flush=True)
            self.chats.pop(task_id, None)
            await event_queue.enqueue_event(
                TaskStatusUpdateEvent(
                    task_id=context.task_id,
                    context_id=context.context_id,
                    status=TaskStatus(
                        state=TaskState.TASK_STATE_FAILED,
                        message=new_text_message(error_msg),
                    ),
                )
            )

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        task_id = context.task_id
        print(f"[financial-advisor] Task {task_id} cancellation requested.", flush=True)
        self.chats.pop(task_id, None)

def build_app() -> Starlette:
    base_dir = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(base_dir, "agent.json"), "r") as f:
        card_data = json.load(f)
        
    skill = AgentSkill(
        id="financial_advisor",
        name=card_data.get("name", "Financial Advisor"),
        description=card_data.get("description", ""),
        tags=["finance"],
    )

    agent_card = AgentCard(
        name=card_data.get("name", "Financial Advisor"),
        description=card_data.get("description", ""),
        version="1.0.0",
        default_input_modes=["text/plain", "application/json"],
        default_output_modes=["text/plain"],
        capabilities=AgentCapabilities(streaming=True),
        supported_interfaces=[
            AgentInterface(
                protocol_binding="JSONRPC",
                url=f"http://127.0.0.1:{PORT}",
            )
        ],
        skills=[skill],
    )

    handler = DefaultRequestHandler(
        agent_executor=FinancialAdvisorExecutor(),
        task_store=InMemoryTaskStore(),
        agent_card=agent_card,
    )

    routes = []
    routes.extend(create_agent_card_routes(agent_card))
    routes.extend(create_jsonrpc_routes(handler, "/"))

    return Starlette(routes=routes)

if __name__ == "__main__":
    app = build_app()
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
