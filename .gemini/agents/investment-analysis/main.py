"""
Investment Analysis ADK Agent
Runs as an A2A server. Jarvis spawns this process with JARVIS_AGENT_PORT env var.

Workflow:
  1. Parse ticker from task input
  2. Concurrently run three sub-analyses via Gemini (macro, sentiment, fundamentals)
  3. Extract ratings from each result
  4. Call investment_memo_generator.py to produce the final memo
  5. Stream the memo back as A2A artifact chunks
"""

import asyncio
import json
import os
import re
import subprocess
import sys
import textwrap
from pathlib import Path

import uvicorn
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
from google import genai
from starlette.applications import Starlette

# ── Config ────────────────────────────────────────────────────────────────────

def _require_env(name: str) -> str:
    """Fail-fast: exit immediately if a required env var is missing."""
    val = os.environ.get(name)
    if not val:
        print(f"[investment-analysis] FATAL: {name} is not set", flush=True, file=sys.stderr)
        sys.exit(1)
    return val


# Validate required env vars at startup so the process exits quickly
# rather than waiting 30 s for the health-check to time out.
_GEMINI_API_KEY = (
    os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or ""
)
if not _GEMINI_API_KEY:
    print("[investment-analysis] FATAL: GEMINI_API_KEY (or GOOGLE_API_KEY) is not set",
          flush=True, file=sys.stderr)
    sys.exit(1)

# JARVIS_AGENT_PORT must be provided by AgentLauncher — no silent fallback.
if "JARVIS_AGENT_PORT" not in os.environ:
    print("[investment-analysis] FATAL: JARVIS_AGENT_PORT is not set",
          flush=True, file=sys.stderr)
    sys.exit(1)

PORT = int(os.environ["JARVIS_AGENT_PORT"])
GEMINI_MODEL = os.environ.get("JARVIS_AGENT_MODEL", "gemini-2.5-flash")
MEMO_SCRIPT = Path.home() / ".gemini-jarvis" / "investment_memo_generator.py"

# ── Gemini client ─────────────────────────────────────────────────────────────

_gemini_client: genai.Client | None = None


def get_gemini_client() -> genai.Client:
    global _gemini_client
    if _gemini_client is None:
        _gemini_client = genai.Client(api_key=_GEMINI_API_KEY)
    return _gemini_client


# ── Sub-analysis prompts ──────────────────────────────────────────────────────

MACRO_PROMPT = textwrap.dedent("""
You are a macro liquidity analyst. Perform a concise macro liquidity assessment.

Search for the latest values of:
1. Fed Total Assets (balance sheet)
2. Treasury TGA balance
3. ON RRP balance
4. SOFR rate
5. MOVE index
6. USD/JPY rate

Compute Fed Net Liquidity = Fed Total Assets - TGA - ON RRP.

Based on your findings, output ONLY a JSON object (no markdown, no explanation):
{
  "liquidity_rating": "Ample Liquidity" | "Neutral Liquidity" | "Tight Liquidity",
  "net_liquidity_usd_bn": <number>,
  "sofr_rate": <number>,
  "move_index": <number>,
  "usdjpy": <number>,
  "summary": "<one sentence>"
}
""").strip()

SENTIMENT_PROMPT = textwrap.dedent("""
You are a US stock market sentiment analyst. Assess current market sentiment.

Search for the latest values of:
1. NAAIM Exposure Index
2. S&P 500 Forward P/E ratio
3. Hedge fund leverage (Goldman Sachs Prime or similar)
4. Retail net buying (recent week)

Based on your findings, output ONLY a JSON object (no markdown, no explanation):
{
  "sentiment_rating": "Extreme Bullish" | "Bullish" | "Neutral" | "Bearish" | "Extreme Bearish",
  "naaim_index": <number>,
  "sp500_forward_pe": <number>,
  "summary": "<one sentence>"
}
""").strip()

FUNDAMENTAL_PROMPT_TEMPLATE = textwrap.dedent("""
You are a value investing analyst. Analyze {ticker} fundamentals.

Search for the latest financial data:
1. ROE for the past 3 years
2. Debt-to-asset ratio
3. Free cash flow vs net income (FCF quality)
4. Economic moat indicators

Score each dimension (0-3 points) and sum up.

Based on your findings, output ONLY a JSON object (no markdown, no explanation):
{{
  "fundamental_rating": "A (10-12)" | "B (7-9)" | "C (4-6)" | "D (0-3)",
  "roe_3yr_avg": <number>,
  "debt_to_asset": <number>,
  "fcf_quality": "High" | "Medium" | "Low",
  "moat": "Wide" | "Narrow" | "None",
  "total_score": <number>,
  "summary": "<one sentence>"
}}
""").strip()


# ── Gemini analysis helper ────────────────────────────────────────────────────

async def run_analysis(prompt: str) -> dict:
    """Call Gemini with grounding/web-search and return parsed JSON."""
    client = get_gemini_client()

    loop = asyncio.get_event_loop()

    def _call():
        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt,
            config=genai.types.GenerateContentConfig(
                tools=[genai.types.Tool(google_search=genai.types.GoogleSearch())],
                temperature=0.1,
            ),
        )
        return response.text or ""

    raw = await loop.run_in_executor(None, _call)

    # Extract JSON from response (may be wrapped in markdown)
    json_match = re.search(r'\{[\s\S]*\}', raw)
    if not json_match:
        raise ValueError(f"No JSON in response: {raw[:200]}")
    return json.loads(json_match.group())


# ── Investment memo generator ─────────────────────────────────────────────────

def run_memo_generator(ticker: str, macro: dict, sentiment: dict, fundamental: dict) -> str:
    """Call investment_memo_generator.py and return its stdout."""
    result = subprocess.run(
        [
            sys.executable,
            str(MEMO_SCRIPT),
            "--ticker", ticker,
            "--macro-json", json.dumps(macro),
            "--sentiment-json", json.dumps(sentiment),
            "--fundamental-json", json.dumps(fundamental),
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(f"memo generator failed: {result.stderr}")
    return result.stdout.strip()


# ── AgentExecutor ─────────────────────────────────────────────────────────────

class InvestmentAnalysisExecutor(AgentExecutor):

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        task = context.current_task or new_task_from_user_message(context.message)
        await event_queue.enqueue_event(task)

        # ── Parse input ───────────────────────────────────────────────────────
        msg_text = ""
        for part in (context.message.parts or []):
            if hasattr(part, "text") and part.text:
                msg_text = part.text
                break

        try:
            input_data = json.loads(msg_text)
            ticker = input_data.get("ticker", "").upper()
        except (json.JSONDecodeError, AttributeError):
            # Fallback: try to extract ticker from plain text
            m = re.search(r'\b([A-Z]{1,5})\b', msg_text.upper())
            ticker = m.group(1) if m else ""

        if not ticker:
            await self._fail(context, event_queue, "No ticker provided. Please specify a stock ticker like NVDA.")
            return

        # ── Step 1: Notify running ────────────────────────────────────────────
        await event_queue.enqueue_event(
            TaskStatusUpdateEvent(
                task_id=context.task_id,
                context_id=context.context_id,
                status=TaskStatus(
                    state=TaskState.TASK_STATE_WORKING,
                    message=new_text_message(f"🔍 启动 {ticker} 三维并发分析..."),
                ),
            )
        )

        # ── Step 2: Concurrent sub-analyses ──────────────────────────────────
        await self._emit_chunk(
            context, event_queue,
            f"## 📊 {ticker} 投资分析报告\n\n"
            f"⏳ 正在并发执行：宏观流动性 | 市场情绪 | 基本面分析...\n\n"
        )

        results = await asyncio.gather(
            run_analysis(MACRO_PROMPT),
            run_analysis(SENTIMENT_PROMPT),
            run_analysis(FUNDAMENTAL_PROMPT_TEMPLATE.format(ticker=ticker)),
            return_exceptions=True,
        )
        errors = [(i, r) for i, r in enumerate(results) if isinstance(r, Exception)]
        if errors:
            dim_names = ["宏观流动性", "市场情绪", "基本面"]
            err_msg = "; ".join(f"{dim_names[i]}: {e}" for i, e in errors)
            await self._fail(context, event_queue, f"分析失败: {err_msg}")
            return
        macro, sentiment, fundamental = results

        # ── Step 3: Emit sub-analysis summaries ───────────────────────────────
        await self._emit_chunk(
            context, event_queue,
            f"✅ 分析完成\n\n"
            f"| 维度 | 评级 | 摘要 |\n"
            f"|------|------|------|\n"
            f"| 宏观流动性 | **{macro.get('liquidity_rating', 'N/A')}** | {macro.get('summary', '')} |\n"
            f"| 市场情绪   | **{sentiment.get('sentiment_rating', 'N/A')}** | {sentiment.get('summary', '')} |\n"
            f"| 基本面     | **{fundamental.get('fundamental_rating', 'N/A')}** | {fundamental.get('summary', '')} |\n\n"
        )

        # ── Step 4: Generate memo ─────────────────────────────────────────────
        try:
            memo = run_memo_generator(ticker, macro, sentiment, fundamental)
        except Exception as e:
            await self._fail(context, event_queue, f"备忘录生成失败: {e}")
            return

        await self._emit_chunk(context, event_queue, memo)

        # ── Step 5: Complete ──────────────────────────────────────────────────
        await event_queue.enqueue_event(
            TaskStatusUpdateEvent(
                task_id=context.task_id,
                context_id=context.context_id,
                status=TaskStatus(state=TaskState.TASK_STATE_COMPLETED),
            )
        )

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        raise Exception("cancel not supported")

    # ── Helpers ───────────────────────────────────────────────────────────────

    async def _emit_chunk(
        self, context: RequestContext, event_queue: EventQueue, text: str
    ) -> None:
        await event_queue.enqueue_event(
            TaskArtifactUpdateEvent(
                task_id=context.task_id,
                context_id=context.context_id,
                artifact=new_text_artifact(name="output", text=text),
            )
        )

    async def _fail(
        self, context: RequestContext, event_queue: EventQueue, message: str
    ) -> None:
        await event_queue.enqueue_event(
            TaskStatusUpdateEvent(
                task_id=context.task_id,
                context_id=context.context_id,
                status=TaskStatus(
                    state=TaskState.TASK_STATE_FAILED,
                    message=new_text_message(message),
                ),
            )
        )


# ── A2A Server setup ──────────────────────────────────────────────────────────

def build_app() -> Starlette:
    skill = AgentSkill(
        id="investment_analysis",
        name="US Stock Investment Analysis",
        description=(
            "三维并发分析美股投资价值：宏观流动性 + 市场情绪 + 基本面，"
            "输出结构化投资决策备忘录。"
        ),
        tags=["investment", "stocks", "analysis", "macro", "fundamentals"],
        examples=["Analyze NVDA", "分析AAPL的投资价值", "GOOGL值得买吗"],
    )

    agent_card = AgentCard(
        name="Investment Analysis Agent",
        description="Jarvis 投资分析专业 Agent — 宏观/情绪/基本面三维分析",
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
        agent_executor=InvestmentAnalysisExecutor(),
        task_store=InMemoryTaskStore(),
        agent_card=agent_card,
    )

    routes = []
    routes.extend(create_agent_card_routes(agent_card))
    routes.extend(create_jsonrpc_routes(handler, "/"))

    return Starlette(routes=routes)


if __name__ == "__main__":
    # Validate memo script exists before accepting any connections
    if not MEMO_SCRIPT.exists():
        print(f"[investment-analysis] FATAL: memo script not found: {MEMO_SCRIPT}",
              flush=True, file=sys.stderr)
        sys.exit(1)

    print(f"[investment-analysis] Starting A2A server on port {PORT}", flush=True)
    app = build_app()
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
