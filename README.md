# 🤖 Jarvis Personal AI Assistant

Jarvis is a persistent, autonomous AI assistant built on top of the Gemini CLI core. It provides a Web UI and a background daemon to handle tasks on your macOS system with maximum privilege and zero friction.

## 🚀 Features

- **Persistent Daemon**: Runs in the background, keeping your session active.
- **Autonomous Agentic Loop**: Automatically executes tool calls (Shell, AppleScript, File IO) without manual approval (YOLO mode).
- **Web Interface**: Modern UI to interact with Jarvis, featuring real-time thought process and tool execution tracking.
- **Full System Control**: Capable of controlling local apps (like QQ Music), creating files, and managing your environment.
- **Max Privilege Protocol**: Deactivates 'headless' and 'external app control' security restrictions.

## 🛠️ Quick Start

### 1. Prerequisites
- **Node.js**: >= 20.0.0
- **API Key**: You need a Google Gemini API Key.

### 2. Setup Environment
Set your API key in your terminal:
```bash
export GOOGLE_API_KEY='your_api_key_here'
```
Or ensure you have logged in via `npx gemini login`.

### 3. Install Dependencies
```bash
npm install
```

### 4. Start Jarvis
```bash
npx tsx packages/jarvis/src/index.ts
```

### 5. Access the UI
Open your browser and navigate to:
👉 **[http://localhost:3000](http://localhost:3000)**

## 🏗️ Development & Build

### Build all packages
```bash
npm run build
```

### Run Jarvis in Dev Mode
```bash
# Uses tsx for hot-reloading and direct execution
npx tsx packages/jarvis/src/index.ts
```

## 🧬 Upstream Sync

This project is maintained as a fork of `google/gemini-cli`. To sync with the latest upstream features:

```bash
git remote add upstream https://github.com/google/gemini-cli.git
git pull upstream main
```

## ⚠️ Security Notice (YOLO Mode)

Jarvis is configured in **Unconstrained Mode**. It will execute shell commands and control applications **automatically** without asking for permission. Use it in a trusted environment and be aware of the actions you request.

## 📜 License

Apache-2.0 (Inherited from gemini-cli)
