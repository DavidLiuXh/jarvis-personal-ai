# 🤖 Jarvis — 你的私人 AI 伙伴

[📄 English Version](./README.md)

Jarvis 是一个深度个性化的 AI 助手。它了解你是谁，记住你的历史，并随着时间不断成长。基于 Gemini CLI 构建，通过微信和飞书融入你的日常生活，主动为你服务，在每一次对话中都变得更懂你。

---

## ✨ Jarvis 的与众不同

### 🧠 它记住你

Jarvis 会建立一份关于你的活的记忆——你的名字、你的习惯、你的偏好、你的决策。每一次对话都被提炼成结构化的知识，塑造着 Jarvis 对你的回应方式。随着时间推移，它会知道你喜欢简洁的回答，你每周跑步三次，你采用核心-卫星投资策略。你再也不需要重复自己。

### 💬 它在你熟悉的地方

通过**微信**或**飞书**与 Jarvis 交流——就是你手机上已有的应用。无需学习新界面，Jarvis 融入你现有的沟通习惯，随时随地响应你。

### ⏰ 它在你睡觉时工作

用自然语言设置定时任务：*"每天工作日晚上，汇总今日市场行情发给我微信。"* Jarvis 自动处理一切——查询、分析、推送——按你的节奏，不需要你在场。

### 🔍 它反思与成长

每天深夜，Jarvis 会悄悄回顾它对你的了解，提炼出更高层次的洞见——你行为中的规律、你兴趣之间的关联、可以更好服务你的观察。这些反思成为它理解你的一部分。

### 🎯 它适应你

Jarvis 根据你的背景调整沟通风格。与工程师说技术语言，与其他人则通俗易懂。它遵循你明确表达的偏好，也推断你隐含的需求。

### 🛠️ 它可以被扩展

把脚本放进一个文件夹，就能给 Jarvis 添加新能力。Python、Bash 或 AppleScript——只要你能写脚本，Jarvis 就能做到。

---

## 🚀 快速开始

### 前置条件

- **Node.js** >= 20.0.0
- **Google 账号**（用于 Google 登录）或 **Gemini API Key**

### 身份认证

**方案 A：Google 账号登录（推荐）**
```bash
npx gemini login
```

**方案 B：API Key**

在项目根目录的 `.env` 文件中添加：
```bash
GOOGLE_API_KEY=你的_API_KEY
```

### 安装与启动

```bash
npm install --ignore-scripts
npx tsx packages/jarvis/src/index.ts
```

> **说明**：使用 `--ignore-scripts` 跳过内置 gemini-cli 包的构建步骤。Jarvis 通过 `tsx` 在运行时直接解析 TypeScript，无需预编译。

打开 **[http://localhost:3000](http://localhost:3000)** 访问 Web 界面。

---

## 🔗 连接通讯渠道

### 微信

在 `~/.gemini-jarvis/config.json` 中启用：
```json
"wechat": {
  "enabled": true,
  "apiBaseUrl": "https://your-wechat-server"
}
```

重启 Jarvis，在终端扫描二维码完成登录。

### 飞书

```json
"feishu": {
  "enabled": true,
  "appId": "your_app_id",
  "appSecret": "your_app_secret"
}
```

---

## ⏰ 定时任务

通过自然语言或 `!task` 命令管理任务：

```
!task add "每天晚上8点" "查询今日 GitHub Trending 并汇总" --channel wechat
!task list
!task run task-id
```

或者直接告诉 Jarvis：*"每周一早上提醒我复盘投资组合。"*

---

## 📁 数据与隐私

Jarvis 的所有数据都存放在 `~/.gemini-jarvis/` 目录下——与你日常使用的 Gemini CLI 完全隔离。记忆、对话历史、配置和任务设置全部存储在本地。

---

## 📜 开源协议

Apache-2.0 — 继承自 [gemini-cli](https://github.com/google-gemini/gemini-cli)
