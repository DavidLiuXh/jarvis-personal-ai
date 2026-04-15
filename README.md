# 🤖 Jarvis — Your Personal AI Companion

[📄 中文文档](./README_cn.md)

Jarvis is a deeply personalized AI assistant that learns who you are, remembers
your history, and grows with you over time. Built on Gemini CLI, it connects to
your life through WeChat and Feishu, acts proactively on your behalf, and
becomes more attuned to you with every conversation.

---

## ✨ What Makes Jarvis Different

### 🧠 It Remembers You — With Depth

Jarvis builds a living memory of who you are — your name, your habits, your
preferences, your decisions. Every conversation is distilled into structured
knowledge that shapes how Jarvis responds to you. Over time, it learns that you
prefer concise answers, that you run three times a week, that you follow a
core-satellite investment strategy. You never have to repeat yourself.

The memory system has been significantly upgraded with a three-layer architecture
(DNI — Dynamic Neural Index):

- **Transparent & Correctable** — All facts are written to `~/.gemini-jarvis/memory/MEMORIES.md` in plain Markdown. Edit the file directly to correct any mistake; Jarvis rebuilds its internal knowledge from it on next startup.
- **Hybrid Retrieval** — Each turn, relevant facts are found using a fusion of vector similarity and BM25 keyword search, re-ranked by importance and recency decay, so the most useful context always surfaces first.
- **Knowledge Graph** — Entities and relationships extracted from your facts (e.g. _David → works_on → jarvis-personal-ai_) let Jarvis expand context along logical connections, not just keyword matches.
- **Nightly Reflection** — Every evening at 22:00, Jarvis consolidates fragmented facts and synthesizes higher-order insights about patterns in your behavior and decisions.

### 💬 It Lives Where You Do

Talk to Jarvis through **WeChat** or **Feishu** — the apps already on your
phone. No new interface to learn. Jarvis fits into your existing communication
habits and responds wherever you are.

### ⏰ It Works While You Sleep

Set up scheduled tasks in plain language: _"Every weekday evening, summarize
today's market and send it to me on WeChat."_ Jarvis handles the rest —
querying, analyzing, and delivering — automatically, on your schedule.

### 🔍 It Reflects and Grows

Each night, Jarvis quietly reviews what it knows about you and synthesizes
higher-level insights — patterns in your behavior, connections between your
interests, observations that might help it serve you better. These reflections
become part of how it understands you.

### 🎯 It Adapts to You

Jarvis adjusts its communication style based on your background. It speaks
technically with engineers, simply with everyone else. It follows your explicit
preferences and infers your implicit ones.

### 🏠 It Runs Locally — Where You Want It To

Jarvis is designed to work with local models wherever cloud APIs are unavailable,
too slow, or simply unnecessary. Through [Ollama](https://ollama.com), you can
run open-source models on your own machine and plug them into Jarvis's core
pipelines:

- **Smart Model Routing** — A small local classifier scores each request's
  complexity (1–100) and automatically routes simple questions to a fast Flash
  model and complex analysis to a Pro model. You save cost and latency without
  sacrificing quality where it matters.
- **Semantic Memory** — Vector embeddings for long-term memory are generated
  locally using models like `bge-m3`, keeping your personal facts and
  conversation history entirely on-device.
- **Knowledge Graph** — Entity extraction that builds the graph of who you are
  and what you work on runs on a local model, with no data leaving your machine.
- **Nightly Reflection** — The consolidation and insight synthesis that happens
  while you sleep can run on a local model, independent of any API quota.

### 🛠️ It Can Be Extended

Give Jarvis new capabilities by dropping scripts into a folder. Python, Bash, or
AppleScript — if you can script it, Jarvis can do it.

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

Add to `.env` in the project root:

```bash
GOOGLE_API_KEY=your_api_key_here
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

To pull the latest upstream gemini-cli changes:

```bash
git submodule update --remote gemini-cli
npm install
```

Open **[http://localhost:3000](http://localhost:3000)** to access the web UI.

---

## ⚙️ Configuration

Jarvis is configured via `~/.gemini-jarvis/config.json`. The file is created automatically on first run with sensible defaults.

For a full reference of all available options with descriptions, see:

- [Configuration Reference](docs/config-reference.md)

---

## 🔗 Connecting Channels

### WeChat

Enable in `~/.gemini-jarvis/config.json`:

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

Manage tasks through natural language or the `!task` command:

```
!task add "每天晚上8点" "查询今日 GitHub Trending 并汇总" --channel wechat
!task list
!task run task-id
```

Or just tell Jarvis: _"Remind me every Monday morning to review my portfolio."_

---

## 📁 Data & Privacy

All Jarvis data lives in `~/.gemini-jarvis/` — completely isolated from your
regular Gemini CLI usage. Memory, chat history, settings, and task
configurations are all stored locally.

---

## 📜 License

Apache-2.0 — inherited from
[gemini-cli](https://github.com/google-gemini/gemini-cli)
