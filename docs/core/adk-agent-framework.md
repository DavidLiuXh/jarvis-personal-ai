# ADK Agent 框架

Jarvis 通过 **ADK Agent 框架**将专业能力委托给按需启动的外部 Python 进程，每个进程实现一个 Google ADK + A2A 协议的 Agent Server。Jarvis 作为 A2A Client（Orchestrator），Agent 作为 A2A Server（专业执行层）。

---

## 整体架构

```
用户消息
  │
  ▼
JarvisAgent.processMessage()
  │
  ├─ agentRouter.routeToAgent()   ← 意图识别，决定是否走 Agent 路径
  │
  ├─ [匹配] ──────────────────────────────────────────────────────────
  │    │
  │    ├─ 立即向用户返回确认消息（非阻塞）
  │    │
  │    └─ AgentManager.createTask()
  │             │
  │             └─ setImmediate → launchTask()
  │                      │
  │                      └─ AgentLauncher.launchAgent()
  │                               │
  │                               ├─ 1. findFreePort()
  │                               ├─ 2. spawn python3 main.py
  │                               ├─ 3. waitForReady() — 轮询 /.well-known/agent-card.json
  │                               ├─ 4. POST / (A2A JSON-RPC message/stream)
  │                               ├─ 5. 解析 SSE 事件流
  │                               │     ├─ artifact → appendChunk() → WebSocket
  │                               │     ├─ completed → completeTask()
  │                               │     ├─ failed → failTask()
  │                               │     └─ input-required → requireInput() + 保持进程
  │                               └─ 6. 进程退出清理
  │
  └─ [未匹配] → 走原有 LLM 路径（refreshContext + Gemini）
```

### 关键设计原则

| 原则         | 说明                                                                         |
| ------------ | ---------------------------------------------------------------------------- |
| **非阻塞**   | createTask() 立即返回，launchTask() 在 setImmediate 里异步执行，不阻塞主对话 |
| **按需启动** | 每个 task 独立 spawn 进程，task 完成后进程退出，不常驻                       |
| **隔离**     | 每个进程分配随机空闲端口，互不干扰                                           |
| **事件驱动** | AgentManager extends EventEmitter，所有状态变更通过事件推送到 WebSocket      |
| **故障安全** | 进程崩溃、超时、Jarvis 退出时，子进程都会被 SIGTERM                          |

---

## 文件结构

```
jarvis/src/core/
  externalAgent.ts     # 类型定义：AgentCard, AgentTask, AgentTaskEvent
  agentRegistry.ts     # 扫描 ~/.gemini-jarvis/agents/ 加载 AgentCard
  agentManager.ts      # 任务生命周期管理，EventEmitter
  agentLauncher.ts     # 进程 spawn + 健康检查 + A2A 调用 + SSE 解析
  agentRouter.ts       # 意图路由：触发词匹配 + 输入提取

~/.gemini-jarvis/agents/
  <agent-id>/
    agent.json         # AgentCard 描述文件
    main.py            # ADK Agent 入口（A2A Server）
    requirements.txt   # Python 依赖
```

---

## 核心数据结构

### AgentCard — Agent 描述

```typescript
type AgentCard = {
  agentId: string; // 唯一标识，如 "investment-analysis"
  name: string; // UI 显示名
  description: string; // 功能描述
  entrypoint: string; // Python 入口脚本绝对路径
  inputSchema: {
    // JSON Schema，定义必填字段
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
  estimatedDuration: string; // 预计时长，如 "2-4 分钟"
  triggers: string[]; // 触发关键词列表
};
```

### AgentTask — 任务状态机

```
pending → starting → running → completed
                   ↘ input_required → running → ...
                   ↘ failed
                   ↘ cancelled
```

| 状态             | 含义                           |
| ---------------- | ------------------------------ |
| `pending`        | 已创建，等待 setImmediate 执行 |
| `starting`       | 进程启动中，等待健康检查通过   |
| `running`        | A2A 调用进行中，流式输出中     |
| `input_required` | Agent 需要用户追加输入         |
| `completed`      | 成功完成                       |
| `failed`         | 失败（进程崩溃/超时/API 错误） |
| `cancelled`      | 用户主动取消                   |

---

## 路由机制（agentRouter）

路由采用**双重门控**，两个条件都满足才触发 Agent：

```
Gate 1: scoreTriggers() >= 1
        ← 提示词与 AgentCard.triggers 至少命中 2 个关键词
        ← 防止单词误触（如 "analyze" 单词匹配就路由）

Gate 2: InputExtractor 返回有效 input
        ← 针对每个 agent 注册专属提取器
        ← investment-analysis 要求能提取到 ticker
        ← 防止"讨论宏观"这类无具体标的的请求被路由
```

**投资分析 Agent 的触发示例：**

| 用户输入               | Gate1                        | Gate2           | 结果   |
| ---------------------- | ---------------------------- | --------------- | ------ |
| `分析NVDA的投资价值`   | ✅ "分析"+"NVDA" = 2 hits    | ✅ ticker=NVDA  | 路由   |
| `帮我看看GOOGL基本面`  | ✅ "GOOGL"+"基本面" = 2 hits | ✅ ticker=GOOGL | 路由   |
| `分析一下宏观流动性`   | ✅ "分析"+"宏观" = 2 hits    | ❌ 无 ticker    | 不路由 |
| `analyze my MA thesis` | ❌ 只有 "analyze" = 1 hit    | —               | 不路由 |

---

## A2A 协议交互

Agent 基于 `a2a-sdk` 暴露 JSON-RPC over HTTP 接口，Jarvis 通过 `agentLauncher.ts` 与之交互。

### 启动与健康检查

```
Jarvis                          Agent Process
  │                                  │
  ├─ spawn python3 main.py ──────────▶
  │  (env: JARVIS_AGENT_PORT=xxxxx)  │
  │                                  │ uvicorn.run(port=xxxxx)
  │                                  │
  ├─ GET /.well-known/agent-card.json ─▶ 200 OK  ← 就绪
  │  (每 500ms 重试，最多 30s)         │
```

### 消息发送（流式）

```json
POST / HTTP/1.1
Content-Type: application/json
Accept: text/event-stream

{
  "jsonrpc": "2.0",
  "id": "<taskId>",
  "method": "message/stream",
  "params": {
    "message": {
      "role": "user",
      "parts": [{"kind": "text", "text": "{\"ticker\": \"NVDA\"}"}],
      "messageId": "<uuid>"
    },
    "configuration": {"acceptedOutputModes": ["text/plain"]}
  }
}
```

### SSE 响应流

```
data: {"result": {"status": {"state": "working", ...}}}

data: {"result": {"artifact": {"parts": [{"kind": "text", "text": "## 分析中..."}]}}}

data: {"result": {"artifact": {"parts": [{"kind": "text", "text": "宏观流动性..."}]}}}

data: {"result": {"status": {"state": "completed"}}}
```

---

## WebSocket 消息协议扩展

Jarvis WebSocket 在原有协议基础上新增 agent 相关消息类型。

### 服务端 → 客户端

| type                   | 含义                   | 关键字段                     |
| ---------------------- | ---------------------- | ---------------------------- |
| `agent_task_created`   | 任务已创建             | `task` (完整 AgentTask 对象) |
| `agent_task_started`   | 进程就绪，A2A 调用开始 | `taskId`                     |
| `agent_task_stream`    | 流式输出 chunk         | `taskId`, `chunk`            |
| `agent_task_done`      | 任务完成               | `taskId`, `output`           |
| `agent_task_failed`    | 任务失败               | `taskId`, `error`            |
| `agent_task_cancelled` | 任务已取消             | `taskId`                     |
| `agent_input_required` | 需要用户追加输入       | `taskId`, `question`         |

### 客户端 → 服务端

| type           | 含义             | 关键字段          |
| -------------- | ---------------- | ----------------- |
| `agent_input`  | 用户提供追加输入 | `taskId`, `value` |
| `agent_cancel` | 用户取消任务     | `taskId`          |

---

## WebUI 任务面板

右侧可折叠任务面板，点击 Header 的 **🤖 Tasks** 按钮展开/收起。

```
┌─────────────────────────────────┐
│ 🤖 Agent Tasks              [✕] │
├─────────────────────────────────┤
│ ┌─────────────────────────────┐ │
│ │ 🤖 investment-analysis      │ │
│ │ Input: {"ticker":"NVDA"}  running│ │
│ │ ┌─────────────────────────┐ │ │
│ │ │ ## 📊 NVDA 投资分析报告  │ │ │
│ │ │ ⏳ 并发执行三维分析...   │ │ │
│ │ └─────────────────────────┘ │ │
│ │ Started: 10:30:00      [✕] │ │
│ └─────────────────────────────┘ │
└─────────────────────────────────┘
```

**状态徽章颜色：**

- `pending` — 灰色
- `starting` — 蓝色
- `running` — 绿色闪烁
- `input_required` — 橙色（显示追加输入框）
- `completed` — 绿色
- `failed` — 红色
- `cancelled` — 深灰

**断线重连：** WebUI 重连后自动调用 `GET /api/agent-tasks?sessionId=xxx` 恢复所有任务状态。

---

## REST API

| 端点                                 | 说明                                     |
| ------------------------------------ | ---------------------------------------- |
| `GET /api/agents`                    | 获取所有已注册的 AgentCard               |
| `GET /api/agent-tasks?sessionId=xxx` | 获取指定会话的任务列表                   |
| `GET /api/agent-tasks/:taskId/logs`  | 获取任务的 agent 进程日志（最近 200 行） |

---

## 如何新增一个 Agent

### 第一步：创建 agent 目录

```bash
mkdir -p ~/.gemini-jarvis/agents/<your-agent-id>
```

### 第二步：编写 agent.json

```json
{
  "agentId": "your-agent-id",
  "name": "Agent 显示名称",
  "description": "一句话描述这个 Agent 做什么",
  "entrypoint": "main.py",
  "inputSchema": {
    "type": "object",
    "properties": {
      "param1": { "type": "string", "description": "参数描述" }
    },
    "required": ["param1"]
  },
  "estimatedDuration": "1-2 分钟",
  "triggers": ["关键词1", "关键词2", "EnglishKeyword"]
}
```

**triggers 设计原则：**

- 至少包含 2-3 个有区分度的词，让 score >= 1（2 词同时命中）才触发
- 避免过于通用的词（"帮我"、"分析"单独使用）
- 可以混合中英文

### 第三步：编写 main.py

标准模板：

```python
import os
import sys
import uvicorn
from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes
from a2a.server.tasks import InMemoryTaskStore
from a2a.types import AgentCapabilities, AgentCard, AgentInterface, AgentSkill
from a2a.types.a2a_pb2 import (
    TaskArtifactUpdateEvent, TaskState, TaskStatus, TaskStatusUpdateEvent
)
from a2a.helpers import new_task_from_user_message, new_text_artifact, new_text_message
from starlette.applications import Starlette

# ── 启动验证（fail-fast，不等 30s 超时）─────────────────────────────────────
if "JARVIS_AGENT_PORT" not in os.environ:
    print("FATAL: JARVIS_AGENT_PORT not set", file=sys.stderr, flush=True)
    sys.exit(1)

# 根据实际认证方式选择其中一种：
# 方式 A：API Key
API_KEY = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
if not API_KEY:
    print("FATAL: GEMINI_API_KEY not set", file=sys.stderr, flush=True)
    sys.exit(1)

# 方式 B：OAuth（复用 Jarvis 的认证，无需 API Key，推荐在中国大陆使用）
# from google.oauth2.credentials import Credentials
# from google.auth.transport.requests import Request
# import json
# from pathlib import Path
# creds_path = Path.home() / ".gemini" / "oauth_creds.json"
# creds_data = json.loads(creds_path.read_text())
# creds = Credentials(
#     token=creds_data.get("token"),
#     refresh_token=creds_data.get("refresh_token"),
#     client_id=creds_data.get("client_id"),
#     client_secret=creds_data.get("client_secret"),
#     token_uri="https://oauth2.googleapis.com/token",
# )

PORT = int(os.environ["JARVIS_AGENT_PORT"])


class MyAgentExecutor(AgentExecutor):
    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        import json
        task = context.current_task or new_task_from_user_message(context.message)
        await event_queue.enqueue_event(task)

        # 解析输入
        msg_text = next(
            (p.text for p in (context.message.parts or []) if hasattr(p, "text") and p.text),
            ""
        )
        try:
            input_data = json.loads(msg_text)
        except json.JSONDecodeError:
            input_data = {"raw": msg_text}

        # 发送 working 状态
        await event_queue.enqueue_event(TaskStatusUpdateEvent(
            task_id=context.task_id,
            context_id=context.context_id,
            status=TaskStatus(
                state=TaskState.TASK_STATE_WORKING,
                message=new_text_message("Processing..."),
            ),
        ))

        # ── 你的业务逻辑 ──────────────────────────────────────────────────────
        result_text = f"处理结果: {input_data}"
        # ─────────────────────────────────────────────────────────────────────

        # 发送结果
        await event_queue.enqueue_event(TaskArtifactUpdateEvent(
            task_id=context.task_id,
            context_id=context.context_id,
            artifact=new_text_artifact(name="output", text=result_text),
        ))
        await event_queue.enqueue_event(TaskStatusUpdateEvent(
            task_id=context.task_id,
            context_id=context.context_id,
            status=TaskStatus(state=TaskState.TASK_STATE_COMPLETED),
        ))

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        raise Exception("cancel not supported")


def build_app():
    skill = AgentSkill(
        id="main_skill",
        name="Main Skill",
        description="主要功能描述",
        tags=[],
        examples=[],
    )
    agent_card = AgentCard(
        name="My Agent",
        description="Agent 描述",
        version="1.0.0",
        default_input_modes=["application/json"],
        default_output_modes=["text/plain"],
        capabilities=AgentCapabilities(streaming=True),
        supported_interfaces=[AgentInterface(
            protocol_binding="JSONRPC",
            url=f"http://127.0.0.1:{PORT}",
        )],
        skills=[skill],
    )
    handler = DefaultRequestHandler(
        agent_executor=MyAgentExecutor(),
        task_store=InMemoryTaskStore(),
        agent_card=agent_card,
    )
    routes = []
    routes.extend(create_agent_card_routes(agent_card))
    routes.extend(create_jsonrpc_routes(handler, "/"))
    return Starlette(routes=routes)


if __name__ == "__main__":
    print(f"[my-agent] Starting on port {PORT}", flush=True)
    uvicorn.run(build_app(), host="127.0.0.1", port=PORT, log_level="warning")
```

### 第四步：注册 InputExtractor（可选但推荐）

在 `agentRouter.ts` 的 `EXTRACTORS` 里注册提取器：

```typescript
// jarvis/src/core/agentRouter.ts

const MY_AGENT_EXTRACTOR: InputExtractor = (prompt) => {
  // 从提示词中提取必要的输入参数
  const match = prompt.match(/某个模式/);
  if (!match) return null;
  return { param1: match[1] };
};

const EXTRACTORS: Record<string, InputExtractor> = {
  "investment-analysis": INVESTMENT_EXTRACTOR,
  "your-agent-id": MY_AGENT_EXTRACTOR, // ← 新增
};
```

**如果不注册 extractor：** 需要 triggers score >= 1（2+ 命中），Jarvis 会把完整用户输入作为 `{ query: userPrompt }` 传给 agent。

### 第五步：重启 Jarvis

重启后 agentRegistry 会自动扫描 `~/.gemini-jarvis/agents/` 加载新 agent，启动日志会显示：

```
🤖 [AgentRegistry] Loaded 2 agent(s): investment-analysis, your-agent-id
```

---

## 认证配置

Agent 子进程通过继承父进程（Jarvis）的环境变量获取认证信息。

### 方式 A：Gemini API Key（需要网络访问 Google API）

```bash
# 在启动 Jarvis 之前设置：
export GEMINI_API_KEY=your_api_key

# 或者写入 ~/.gemini-jarvis/.env（Jarvis 启动时自动加载）
echo "GEMINI_API_KEY=your_api_key" >> ~/.gemini-jarvis/.env
```

> **注意：** Gemini API 在中国大陆受地域限制，需要通过代理访问。
> 如果 Jarvis 已配置 `HTTPS_PROXY`，agent 子进程会自动继承。

### 方式 B：OAuth 复用（推荐，无地域限制）

复用 Jarvis 的 OAuth 认证（`~/.gemini/oauth_creds.json`），在 `main.py` 里使用 `google.oauth2.credentials.Credentials` 加载，无需额外配置。详见上方模板中"方式 B"注释。

---

## 测试指南

### 单元测试：agentRouter

```bash
npx vitest run "agentRouter"
```

测试覆盖：触发词匹配、ticker 提取、误触发防护、跨语言匹配。

### 手动测试 Agent 进程

```bash
# 测试 agent 能否正常启动并响应健康检查
JARVIS_AGENT_PORT=19999 GEMINI_API_KEY=xxx \
  python3 ~/.gemini-jarvis/agents/investment-analysis/main.py &

sleep 3

# 验证 agent card（健康检查端点）
curl -s http://127.0.0.1:19999/.well-known/agent-card.json | python3 -m json.tool

# 发送 A2A 测试请求
curl -s -X POST http://127.0.0.1:19999/ \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": "test-1",
    "method": "message/stream",
    "params": {
      "message": {
        "role": "user",
        "parts": [{"kind": "text", "text": "{\"ticker\": \"NVDA\"}"}],
        "messageId": "msg-1"
      },
      "configuration": {"acceptedOutputModes": ["text/plain"]}
    }
  }'

kill %1
```

### 端到端测试（通过 Jarvis WebUI）

1. 启动 Jarvis（确保 `GEMINI_API_KEY` 已设置或代理已配置）
2. 打开 WebUI
3. 发送触发消息，例如：
   ```
   分析NVDA的投资价值
   帮我看看AAPL基本面
   TSLA值得持有吗
   ```
4. 验证：
   - Jarvis 立即返回确认消息
   - Header 出现 "🤖 Tasks 1"
   - 任务面板显示任务卡片，状态从 `starting` → `running`
   - 2-4 分钟后显示完整分析报告，状态变 `completed`

### 调试

```bash
# 查看任务列表
curl http://localhost:<port>/api/agent-tasks?sessionId=<sessionId>

# 查看任务进程日志（最近 200 行）
curl http://localhost:<port>/api/agent-tasks/<taskId>/logs
```

---

## 当前已有 Agent

### investment-analysis — 投资分析

**路径：** `~/.gemini-jarvis/agents/investment-analysis/`

**功能：** 对美股进行宏观流动性、市场情绪、基本面三维并发分析，输出结构化投资决策备忘录。

**触发词：** `分析` `analyze` `投资` `买入` `卖出` `持有` `股票` `基本面` `宏观` `情绪` 以及常见股票代码（NVDA、AAPL、MSFT 等）

**工作流：**

```
用户输入 (ticker)
  │
  ├─ 并发三维分析（via Gemini + Google Search）
  │   ├─ 宏观流动性（Fed Net Liquidity, SOFR, MOVE, USD/JPY）
  │   ├─ 市场情绪（NAAIM, S&P 500 P/E, Hedge Fund Leverage）
  │   └─ 基本面（ROE 3年, 负债率, FCF 质量, 经济护城河）
  │
  ├─ 各维度输出 JSON 评级
  │
  └─ 调用 investment_memo_generator.py
       └─ 输出结构化 Markdown 投资备忘录
```

**输入 Schema：**

```json
{ "ticker": "NVDA" }
```

**依赖：** `GEMINI_API_KEY`（或 OAuth）、`~/.gemini-jarvis/investment_memo_generator.py`

---

## 未来扩展方向

- **任务持久化**：将 AgentTask 写入 SQLite，Jarvis 重启后恢复未完成任务
- **Agent 热加载**：文件监听 `~/.gemini-jarvis/agents/` 目录，无需重启 Jarvis 即可加载新 agent
- **常驻模式**：高频使用的 agent 可以保持进程运行，设置空闲超时自动退出
- **多 Agent 协同**：一个任务拆分给多个 agent 并发执行，结果由 Jarvis 聚合
- **Agent 市场**：统一的 agent.json 格式使得 agent 可以打包分发
