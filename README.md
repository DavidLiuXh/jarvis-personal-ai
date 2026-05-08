# 🤖 Jarvis — Your Personal AI Companion

[📄 中文文档](./README_cn.md)

Jarvis is a deeply personalized AI assistant that learns who you are, remembers your history, and grows with you over time. Built on Gemini CLI, it connects to your life through WeChat and Feishu, acts proactively on your behalf, and becomes more attuned to you with every conversation.

---

## ✨ What Makes Jarvis Different

### 🧠 Long-Term Memory That Actually Works

Jarvis builds a living memory of who you are — your preferences, decisions, and patterns. Every conversation is distilled into structured knowledge that shapes future responses. You never have to repeat yourself.

The memory system uses a three-layer architecture:

- **Hybrid Retrieval** — Relevant facts are found via vector similarity + BM25 keyword search, re-ranked by importance and recency decay. The most useful context always surfaces first.
- **Precision Injection** — Memory is injected with confidence scoring: high-confidence memories are marked as verified facts; low-confidence ones are flagged as hints only. This prevents LLM from treating weak matches as hard evidence.
- **Knowledge Graph** — Entities and relationships extracted from your facts let Jarvis expand context along logical connections, not just keyword matches.
- **Transparent & Correctable** — All facts live in `~/.gemini-jarvis/memory/MEMORIES.md` as plain Markdown. Edit directly to correct mistakes; Jarvis rebuilds from it on next startup.
- **Nightly Reflection** — Every evening, Jarvis consolidates fragmented facts and synthesizes higher-order insights about patterns in your behavior and decisions.

### 🎯 Smart Model Routing

Jarvis classifies every request locally before sending it to the cloud:

- **Complexity scoring** — A small local model (via Ollama) scores each request 1–100 across knowledge depth and operational difficulty.
- **Subject classification** — Requests are classified as `personal` / `external` / `mixed`, which gates memory injection to prevent context adhesion from irrelevant history.
- **Auto model selection** — Simple questions route to a fast Flash model; complex analysis routes to Pro. You save cost and latency without sacrificing quality where it matters.
- **Temporal awareness** — Date references ("yesterday", "last week", "4月27日") are resolved to exact date ranges before memory search, enabling precise historical recall.

### ⚡ Background Tasks & A2A Agent Network

**Long-running tasks run in the background** — prefix any request with `bg:` / `后台:` / `async:` and Jarvis dispatches it to an isolated background agent. You get an immediate acknowledgment, and the result is pushed to your channel (WeChat/Feishu) when done. Complex research, data analysis, or multi-step workflows no longer block your conversation.

**Agent-to-Agent (A2A) protocol** — Jarvis speaks the A2A standard, letting it invoke specialized agents on demand. Need deep investment analysis, market sentiment scoring, or a domain-specific workflow? Jarvis routes the request to the right agent and integrates the result — all within the same conversation flow.

### 💬 It Lives Where You Do

Talk to Jarvis through **WeChat** or **Feishu** — apps already on your phone. No new interface to learn.

### ⏰ It Works While You Sleep

Set up scheduled tasks in plain language: _"Every weekday evening, summarize today's market and send it to WeChat."_ Jarvis handles querying, analyzing, and delivering — automatically.

### 🏠 Privacy-First, Runs Locally

All personal data stays in `~/.gemini-jarvis/`. Key pipelines — embeddings, routing, entity extraction, reflection — can run entirely on local models via [Ollama](https://ollama.com), with no data leaving your machine.

### 🛠️ Token Efficiency

Jarvis aggressively minimizes the tokens sent per request:

- **History stripping** — `thoughtSignature` blobs and tool call parts are removed from old conversation turns before each request.
- **Utility tool optimization** — Internal LLM calls (e.g. web search grounding) skip the system instruction entirely.
- **Adaptive history compression** — Long conversations are automatically summarized; only recent raw turns are kept in context.
- **`!clear` command** — Manually compress and reset context when switching topics.

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** >= 20.0.0
- A **Google Account** (for Google Login) or a **Gemini API Key**

### Authentication

**Option A: Google Login (Recommended)**

```bash
npx gemini login
```

**Option B: API Key**

Set in `~/.gemini-jarvis/config.json`:

```json
"api": {
  "key": "your_api_key_here"
}
```

### Install & Run

```bash
# Clone with submodules (required)
git clone --recurse-submodules https://github.com/DavidLiuXh/jarvis-personal-ai.git
cd jarvis-personal-ai

npm install
npx tsx jarvis/src/index.ts
```

> If you already cloned without `--recurse-submodules`, run
> `git submodule update --init --recursive` first.

### Updating gemini-cli

Jarvis maintains local patches on top of upstream gemini-cli. Use the provided script to update safely:

```bash
./scripts/update-gemini-cli.sh
git add gemini-cli && git commit -m "chore: update gemini-cli submodule"
npm install
```

Open **[http://localhost:3000](http://localhost:3000)** to access the web UI.

---

## ⚙️ Configuration

Jarvis is configured via `~/.gemini-jarvis/config.json`, created automatically on first run with sensible defaults.

For a full reference of all available options, see [Configuration Reference](docs/config-reference.md).

---

## 🔗 Connecting Channels

### WeChat

```json
"wechat": {
  "enabled": true,
  "apiBaseUrl": "https://your-wechat-server"
}
```

Restart Jarvis and scan the QR code in the terminal to log in.

### Feishu

```json
"feishu": {
  "enabled": true,
  "appId": "your_app_id",
  "appSecret": "your_app_secret"
}
```

---

## ⏰ Scheduled Tasks

```
!task add "每天晚上8点" "查询今日 GitHub Trending 并汇总" --channel wechat
!task list
!task run task-id
```

Or just tell Jarvis: _"Remind me every Monday morning to review my portfolio."_

---

## 📁 Data & Privacy

All Jarvis data lives in `~/.gemini-jarvis/` — completely isolated from your regular Gemini CLI usage. Memory, chat history, settings, and task configurations are stored locally.

---

## 📜 License

Apache-2.0 — inherited from [gemini-cli](https://github.com/google-gemini/gemini-cli)
