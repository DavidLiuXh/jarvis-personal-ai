# 🤖 Jarvis 个人 AI 助手

Jarvis 是一个基于 Gemini CLI 核心构建的常驻、自主 AI 助手。它提供 Web UI 界面和后台守护进程，旨在以最高权限、零阻力地处理您 macOS 系统上的任务。

## 🚀 核心特性

- **常驻守护进程**：在后台持续运行，保持您的会话始终在线。
- **自主执行循环 (Autonomous Agentic Loop)**：自动执行工具调用（如 Shell、AppleScript、文件 IO），无需手动确认（YOLO 模式）。
- **Web 交互界面**：现代化的 UI 界面，支持实时查看 AI 的思考过程和工具执行轨迹。
- **全系统控制**：具备控制本地应用（如 QQ 音乐）、创建文件以及管理环境的能力。
- **最高权限协议**：已解除“无头模式”和“外部应用控制”的安全性限制。

## 🛠️ 快速开始

### 1. 前置条件
- **Node.js**：>= 20.0.0
- **API Key**：您需要一个 Google Gemini API Key。

### 2. 环境配置
在终端中设置您的 API Key：
```bash
export GOOGLE_API_KEY='您的_API_KEY'
```
或者确保您已通过 `npx gemini login` 完成登录。

### 3. 安装依赖
```bash
npm install
```

### 4. 启动 Jarvis
```bash
npx tsx packages/jarvis/src/index.ts
```

### 5. 访问界面
打开浏览器并访问：
👉 **[http://localhost:3000](http://localhost:3000)**

## 🏗️ 开发与构建

### 构建所有软件包
```bash
npm run build
```

### 开发模式运行
```bash
# 使用 tsx 实现热重载和直接运行
npx tsx packages/jarvis/src/index.ts
```

## 🧬 上游同步

本项目作为 `google/gemini-cli` 的分支进行维护。如需同步上游最新特性，请执行：

```bash
git remote add upstream https://github.com/google/gemini-cli.git
git pull upstream main
```

## ⚠️ 安全提示 (YOLO 模式)

Jarvis 配置为 **“非限制模式”**。它将**自动执行** Shell 命令和控制应用程序，而不会询问您的许可。请在受信任的环境中使用，并留意您下达的指令。

## 📜 开源协议

Apache-2.0 (继承自 gemini-cli)
