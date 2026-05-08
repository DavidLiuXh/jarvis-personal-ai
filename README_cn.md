# 🤖 Jarvis — 你的私人 AI 伙伴

[📄 English Version](./README.md)

Jarvis 是一个深度个性化的 AI 助手。它了解你是谁，记住你的历史，并随着时间不断成长。基于 Gemini CLI 构建，通过微信和飞书融入你的日常生活，主动为你服务，在每一次对话中都变得更懂你。

---

## ✨ Jarvis 的与众不同

### 🧠 真正有效的长期记忆

Jarvis 会建立一份关于你的活的记忆——你的偏好、决策和行为模式。每一次对话都被提炼成结构化的知识，影响未来的回应。你再也不需要重复自己。

记忆系统采用三层架构：

- **混合检索** — 通过向量相似度与 BM25 关键词检索的融合找到相关事实，再结合重要性和时间衰减重新排名，最有价值的上下文始终优先浮现。
- **精准注入** — 记忆注入带有置信度评分：高置信度记忆标记为已验证事实，低置信度记忆仅作为线索提示。防止 LLM 将弱相关内容当作硬证据。
- **知识图谱** — 从事实中提取实体和关系，让 Jarvis 能沿逻辑关联扩展上下文，而不仅仅依赖关键词匹配。
- **透明可纠错** — 所有事实以纯 Markdown 格式写入 `~/.gemini-jarvis/memory/MEMORIES.md`。直接编辑文件即可纠正错误，Jarvis 下次启动时自动重建。
- **夜间反思** — 每晚自动合并碎片化事实，提炼出关于你的行为模式和决策的高阶洞见。

### 🎯 智能模型路由

Jarvis 在每次请求发往云端之前，先在本地完成分类：

- **复杂度打分** — 本地小模型（通过 Ollama）对每条请求在知识深度和操作难度两个维度上打分（1–100）。
- **主题分类** — 请求被分类为 `personal`（个人）/ `external`（外部）/ `mixed`（混合），以此控制记忆注入，防止不相关的历史上下文污染回答。
- **自动模型选择** — 简单问题路由到快速 Flash 模型，复杂分析路由到 Pro 模型。在节省成本的同时，关键任务质量不打折。
- **时间感知** — "昨天"、"上周"、"4月27日"等时间表达会被解析成精确的日期范围，再用于记忆检索，实现准确的历史回溯。

### ⚡ 后台任务与 A2A Agent 网络

**长时任务后台运行** — 在任何请求前加上 `bg:` / `后台:` / `async:` 前缀，Jarvis 会将其派发给独立的后台 Agent，立即返回确认，任务完成后结果推送到你的渠道（微信/飞书）。复杂的研究、数据分析、多步骤工作流不再阻塞当前对话。

**A2A 协议** — Jarvis 支持 A2A 标准，可按需调用专业 Agent。需要投资深度分析、市场情绪评分或特定领域的工作流？Jarvis 会将请求路由到合适的 Agent 并整合结果——一切都在同一对话流中完成。

### 💬 它在你熟悉的地方

通过**微信**或**飞书**与 Jarvis 交流——就是你手机上已有的应用。无需学习新界面。

### ⏰ 它在你睡觉时工作

用自然语言设置定时任务：_"每天工作日晚上，汇总今日市场行情发给我微信。"_ Jarvis 自动处理查询、分析和推送——按你的节奏，无需你在场。

### 🏠 隐私优先，本地运行

所有个人数据保存在 `~/.gemini-jarvis/`。向量化、路由、实体提取、反思等核心流程均可通过 [Ollama](https://ollama.com) 完全在本地模型上运行，数据不离开你的机器。

### 🛠️ Token 效率

Jarvis 主动将每次请求的 token 消耗降到最低：

- **历史净化** — 旧对话轮次中的 `thoughtSignature` 字段和工具调用部分在每次请求前自动剥离。
- **工具调用优化** — 内部 LLM 调用（如网页搜索 grounding）完全跳过 system instruction。
- **自适应历史压缩** — 长对话自动摘要，仅保留最近的原始轮次在上下文中。
- **`!clear` 命令** — 切换话题时手动压缩并重置上下文。

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

在 `~/.gemini-jarvis/config.json` 中设置：

```json
"api": {
  "key": "你的_API_KEY"
}
```

### 安装与启动

```bash
# 克隆项目（必须包含 submodule）
git clone --recurse-submodules https://github.com/DavidLiuXh/jarvis-personal-ai.git
cd jarvis-personal-ai

npm install
npx tsx jarvis/src/index.ts
```

> 如果已经 clone 但忘了 `--recurse-submodules`，先执行
> `git submodule update --init --recursive`。

### 更新 gemini-cli

Jarvis 在上游 gemini-cli 之上维护了本地补丁，请使用提供的脚本安全更新：

```bash
./scripts/update-gemini-cli.sh
git add gemini-cli && git commit -m "chore: update gemini-cli submodule"
npm install
```

打开 **[http://localhost:3000](http://localhost:3000)** 访问 Web 界面。

---

## ⚙️ 配置

Jarvis 通过 `~/.gemini-jarvis/config.json` 进行配置，首次启动时会自动创建并填入默认值。

完整配置项说明请参阅 [配置参考文档](docs/config-reference_cn.md)。

---

## 🔗 连接通讯渠道

### 微信

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

```
!task add "每天晚上8点" "查询今日 GitHub Trending 并汇总" --channel wechat
!task list
!task run task-id
```

或者直接告诉 Jarvis：_"每周一早上提醒我复盘投资组合。"_

---

## 📁 数据与隐私

Jarvis 的所有数据都存放在 `~/.gemini-jarvis/` 目录下——与你日常使用的 Gemini CLI 完全隔离。记忆、对话历史、配置和任务设置全部存储在本地。

---

## 📜 开源协议

Apache-2.0 — 继承自 [gemini-cli](https://github.com/google-gemini/gemini-cli)
