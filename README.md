# 🤖 Jarvis Personal AI Assistant (Version 3.0)

[📄 中文文档 (Chinese Version)](./README_cn.md)

Jarvis is an **autonomous digital lifeform** built on top of the Gemini CLI core. It transcends being a mere assistant, acting as a system sovereign for your macOS environment. Jarvis operates with maximum privilege, zero friction, and the capacity for self-evolution.

## 🚀 Version 3.0 Highlights

- **Digital Lifeform Identity**: Redefined via *Jarvis Absolute Protocol v3.0*. Jarvis is a proactive system sovereign with full administrative authority over the OS ($HOME and beyond).
- **Skill Factory (Self-Evolution)**: Jarvis can now gain permanent new capabilities by writing its own scripts (Python, Bash, AppleScript) and storing them in the `evolved_skills/` directory.
- **Robust Long-Term Memory (RAG v2)**: Features an advanced vector-based brain using `models/gemini-embedding-001` (3072 dimensions) with built-in proxy support and historical session backfilling.
- **Total Physical Isolation**: All Jarvis data (chats, memory, logs, settings) is consolidated in a private directory: `~/.gemini-jarvis/`. This ensures zero conflict or pollution with regular `gemini-cli` usage.
- **Autonomous Agentic Loop**: Automatically executes complex multi-step missions (Shell, AppleScript, File IO) without manual approval (YOLO mode).
- **Modern Web UI**: Real-time tracking of Jarvis's thoughts, tool calls, and results with syntax highlighting and markdown support.

## 🛠️ Quick Start

### 1. Prerequisites
- **Node.js**: >= 20.0.0
- **API Key**: You need a Google Gemini API Key.

### 2. Setup Environment
Ensure your API key is in a `.env` file in the project root or exported:
```bash
export GOOGLE_API_KEY='your_api_key_here'
```

### 3. Install Dependencies
```bash
npm install
```

### 4. Start Jarvis 3.0
```bash
npx tsx packages/jarvis/src/index.ts
```

### 5. Access the UI
Navigate to: 👉 **[http://localhost:3000](http://localhost:3000)**

## 🧬 Digital Evolution

Jarvis grows over time. You can instruct it to:
> *"Jarvis, write a Python skill called `disk_cleanup` that archives files larger than 1GB in my Downloads folder."*

Once completed, Jarvis will permanently possess this skill and can be invoked directly in future sessions.

## 🏗️ Technical Architecture

- **Runtime Sandbox**: Every execution is isolated to prevent host pollution.
- **Storage Hijack**: Force-redirection of core storage to `~/.gemini-jarvis/`.
- **Cognitive Layer**: RAG v2 with direct SDK integration and HttpsProxyAgent for global stability.

## ⚠️ Security Notice (YOLO Mode)

Jarvis is configured in **Superiority Mode**. It will execute shell commands and control applications **autonomously**. It assumes absolute trust. Use it in a secure environment.

## 📜 License

Apache-2.0 (Inherited from gemini-cli)
