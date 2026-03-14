# 🤖 Jarvis 个人 AI 助手 (Version 3.0)

[📄 English Version](./README.md)

Jarvis 是一个基于 Gemini
CLI 核心构建的**自主数字生命体**。它超越了传统助手的范畴，成为您 macOS 环境的系统主宰。Jarvis 以最高权限运行，具备零阻力执行能力和持续自我进化的潜力。

## 🚀 3.0 版本亮点

- **数字生命体身份**：通过 _Jarvis Absolute Protocol v3.0_
  重新定义。Jarvis 是一个主动的系统管理员，对操作系统（$HOME 及其以外）拥有完全管理权。
- **技能工厂 (自我进化)**：Jarvis 现在可以通过编写自己的脚本（Python、Bash、AppleScript）并将其存储在
  `evolved_skills/` 目录中，从而永久获得新能力。
- **分层记忆架构 (Tiered
  Memory)**：Jarvis 能区分瞬时的对话记录和永久性的核心事实。
  - **AI 优先蒸馏**：通过后台“隐身会话”自动提取身份、偏好和交互规则。
  - **规则兜底引擎**：内置正则表达式安全网，确保即使 AI 判断保守，关键事实（如姓名、明确偏好）也不会被遗漏。
  - **结构化存储**：高价值事实存放在专用的 `facts` 表中，在对话开始前优先加载。
- **稳健的长期记忆 (RAG v2)**：采用
  `models/gemini-embedding-001`（3072 维）的高级向量大脑，内置代理支持。
- **绝对物理隔离**：Jarvis 的所有数据（聊天记录、记忆、日志、设置）统一收拢在私有目录
  `~/.gemini-jarvis/` 中。这确保了与原生 `gemini-cli` 的零冲突和零污染。
- **自主执行循环**：无需手动确认即可自动执行复杂的多步任务（Shell、AppleScript、文件 IO），进入真正的“无人值守”模式（YOLO 模式）。
- **蜂群模式 (Swarm
  Mode - 并行智能)**：引入“蜂群指挥官”协议。Jarvis 会自动将复杂任务拆解为独立子任务，并同时派发多个子智能体（如代码调查官、通用执行官）或自进化技能并行执行。
- **现代化 Web
  UI**：实时追踪 Jarvis 的思考过程、工具调用及结果，支持代码高亮和 Markdown 渲染。

## 🛠️ 快速开始

### 1. 前置条件

- **Node.js**：>= 20.0.0
- **API Key**：您需要一个 Google Gemini API Key。

### 2. 身份认证配置

Jarvis 通过底层 Gemini CLI 核心支持两种认证方式：

#### 方案 A：Google 账号登录 (推荐 OAuth 方式)

如果您希望使用 Google 账号，请先通过 Gemini
CLI 完成初始化登录。Jarvis 会自动继承您的活跃会话：

```bash
# 在浏览器中完成授权登录
npx gemini login
```

#### 方案 B：使用 API Key

确保您的 API Key 已填入项目根目录的 `.env` 文件中，或在终端导出：

```bash
export GOOGLE_API_KEY='您的_API_KEY'
```

### 3. 安装依赖

```bash
npm install
```

### 4. 启动 Jarvis 3.0

```bash
npx tsx packages/jarvis/src/index.ts
```

### 5. 访问界面

打开浏览器并访问：👉 **[http://localhost:3000](http://localhost:3000)**

## 🧬 数字进化

Jarvis 会随时间不断成长。您可以指令它：

> _“Jarvis，写一个名为 `disk_cleanup`
> 的 Python 技能，帮我把下载文件夹中大于 1GB 的文件进行归档。”_

任务完成后，Jarvis 将永久拥有这项技能，并能在未来的对话中直接调用。

## 🏗️ 技术架构

- **运行时沙箱**：每个执行过程都是隔离的，防止主机环境污染。
- **存储劫持**：强制将内核存储重定向至 `~/.gemini-jarvis/`。
- **认知层**：RAG v2，直接集成 SDK 并注入 HttpsProxyAgent 以确保全球稳定性。

## ⚠️ 安全提示 (YOLO 模式)

Jarvis 配置为 **“主宰模式”**。它将**自主执行**
Shell 命令和控制应用程序。它假定您授予了绝对信任。请在安全的环境中使用。

## 📜 开源协议

Apache-2.0 (继承自 gemini-cli)
