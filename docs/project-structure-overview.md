# Jarvis 项目结构速览

这份文档用于快速回答三个问题：

1. 这个仓库到底是什么
2. 主要代码在哪
3. 出问题时应该先看哪里

## 一句话定位

这个仓库不是从零实现的一整套 agent 框架，而是：

- `gemini-cli/` 作为上游内核
- `jarvis/` 作为面向“个人 AI 助手 / 数字分身”的定制层

可以把它理解成一个基于 Gemini CLI 二次开发的个人 AI 系统，重点增强了：

- 长期记忆
- WeChat / Feishu 渠道接入
- 定时主动任务
- 本地 Ollama 协同
- 可扩展 skills / agents

## 仓库顶层结构

```text
.
├── README.md
├── README_cn.md
├── docs/
├── jarvis/
├── gemini-cli/
└── .gemini/
```

各目录作用：

- `jarvis/`
  Jarvis 的主业务代码，真正的产品定制层。
- `gemini-cli/`
  上游 Gemini CLI 子模块，提供模型客户端、调度器、工具体系、CLI/UI 等底座能力。
- `docs/`
  Jarvis 自己的设计和配置文档。
- `.gemini/`
  项目级扩展资源，包括 agents、skills、commands。

## Workspace 与启动方式

根目录 [package.json](/Users/lw/opensource/jarvis-personal-ai/package.json) 表明这是一个 npm workspace：

- `jarvis`
- `gemini-cli/packages/core`
- `gemini-cli/packages/cli`

常用启动方式：

```bash
npm install
npx tsx jarvis/src/index.ts
```

默认入口在 [jarvis/src/index.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/index.ts)。

## 运行形态

Jarvis 不是一次性脚本，而是一个常驻服务。

启动时会做这些事：

- 读取仓库根目录 `.env`
- 读取 `~/.gemini-jarvis/config.json`
- 视配置决定是否启用特殊安全策略
- 将运行目录切换到 `~/.gemini-jarvis/runtime`
- 启动 HTTP / WebSocket / 渠道 / 任务调度

这意味着：

- 仓库目录保存代码
- `~/.gemini-jarvis/` 保存配置、记忆、任务和运行态数据

## 最重要的代码入口

### 1. 服务入口

[jarvis/src/index.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/index.ts)

职责：

- 加载环境变量与配置
- 初始化 `JarvisServer`
- 启动 WebSocket 和 HTTP 服务
- 注册 WeChat / Feishu 渠道
- 初始化任务系统与后台任务

如果要理解“整个系统怎么启动”，先看这里。

### 2. Agent 管理

[jarvis/src/core/manager.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/manager.ts)

职责：

- 按 `sessionId` 获取或创建 `JarvisAgent`
- 统一持有 `MemoryService`
- 在全局会话模式下，让不同渠道共享同一个 agent

如果你要查“一个会话是怎么被复用的”，先看这里。

### 3. 主会话代理

[jarvis/src/core/agent.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/agent.ts)

这是最核心的业务文件之一，负责：

- 首次初始化 Gemini client / scheduler
- 刷新 system prompt
- 检索长期记忆和历史上下文
- 处理流式回复
- 进入工具调用循环
- 回答结束后触发后台记忆提炼

如果你要理解“收到一条消息后发生了什么”，这里是主战场。

### 4. 配置中心

[jarvis/src/core/configManager.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/configManager.ts)

职责：

- 读取 `~/.gemini-jarvis/config.json`
- 提供统一配置访问

配置项文档见：

- [docs/config-reference.md](/Users/lw/opensource/jarvis-personal-ai/docs/config-reference.md)

## 长期记忆系统

长期记忆是 Jarvis 和普通聊天壳子的主要区别。

核心实现文件：

- [jarvis/src/core/memory.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/memory.ts)

从当前实现看，记忆系统包括几层：

- 事实层：结构化 facts
- 会话记忆层：历史 conversation / events
- 向量检索层：`sqlite-vec`
- 关键词检索层：FTS5 / BM25
- 实体关系层：knowledge graph

技术实现上主要使用：

- `better-sqlite3`
- `sqlite-vec`
- 本地文件目录 `~/.gemini-jarvis/memory/`

围绕记忆系统的相关模块还有：

- `backgroundDistiller.ts`
  对对话做后台事实提炼。
- `entityExtractor.ts`
  从 facts 中抽取实体与关系。
- `sessionSummarizer.ts`
  在恢复历史会话时做摘要压缩。
- `systemPromptBuilder.ts`
  把检索到的事实、记忆、技能拼回当前 prompt。

配套文档：

- [docs/DNI_ARCHITECTURE.md](/Users/lw/opensource/jarvis-personal-ai/docs/DNI_ARCHITECTURE.md)
- [docs/dni-memory-system.md](/Users/lw/opensource/jarvis-personal-ai/docs/dni-memory-system.md)
- [docs/memory-system-deep-dive.md](/Users/lw/opensource/jarvis-personal-ai/docs/memory-system-deep-dive.md)

## 主动任务系统

相关文件：

- [jarvis/src/core/taskScheduler.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/taskScheduler.ts)
- [jarvis/src/core/proactiveTaskRunner.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/proactiveTaskRunner.ts)
- [jarvis/src/core/taskCommandHandler.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/taskCommandHandler.ts)

职责划分大致是：

- `TaskScheduler`
  从 `~/.gemini-jarvis/tasks.json` 读取任务并注册 cron。
- `ProactiveTaskRunner`
  真正执行触发后的主动任务。
- `TaskCommandHandler`
  处理 `!task` 相关命令。

默认内置了一个 nightly reflection 定时任务，时间是每天 `22:00`。

## 渠道接入

相关文件：

- [jarvis/src/core/channels/wechat.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/channels/wechat.ts)
- [jarvis/src/core/channels/feishu.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/channels/feishu.ts)
- [jarvis/src/core/channelRegistry.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/channelRegistry.ts)

作用：

- 接收外部消息
- 将 Jarvis 回复推送回对应渠道
- 为主动任务选择输出通道

如果你在排查“为什么微信/飞书没有回消息”，从这几个文件开始最合适。

## 工具与模型执行链

相关文件：

- [jarvis/src/core/toolRouter.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/toolRouter.ts)
- [jarvis/src/core/agentInitializer.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/agentInitializer.ts)
- [jarvis/src/core/dynamicToolRegistry.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/dynamicToolRegistry.ts)
- [jarvis/src/core/localModelRouter.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/localModelRouter.ts)

大致关系：

- `AgentInitializer`
  负责把 Jarvis 和 gemini-cli 底层对象接起来。
- `ToolRouter`
  把模型发出的工具调用路由到 Jarvis 原生工具或 gemini-cli scheduler。
- `DynamicToolRegistry`
  管理可动态注册的工具能力。
- `LocalModelRouter`
  用本地模型对请求复杂度打分，决定用 Pro 还是 Flash。

## 项目内扩展资源

### Agents

目录：

- [.gemini/agents](/Users/lw/opensource/jarvis-personal-ai/.gemini/agents)

当前能看到的项目级 agents：

- `financial-advisor`
- `investment-analysis`

Agent 注册加载逻辑在：

- [jarvis/src/core/agentRegistry.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/agentRegistry.ts)

Jarvis 会同时扫描两类目录：

- `~/.gemini-jarvis/agents/`
- `<repo>/.gemini/agents/`

### Skills

目录：

- [.gemini/skills](/Users/lw/opensource/jarvis-personal-ai/.gemini/skills)

当前项目里已有：

- `code-reviewer`
- `dmii`
- `docs-changelog`
- `docs-writer`
- `github-issue-creator`
- `mac-timer`
- `pr-address-comments`
- `pr-creator`

### Commands

目录：

- [.gemini/commands](/Users/lw/opensource/jarvis-personal-ai/.gemini/commands)

这些文件更像预置命令模板或工作流入口。

## 推荐阅读顺序

如果你是第一次接这个仓库，建议按这个顺序看：

1. [README.md](/Users/lw/opensource/jarvis-personal-ai/README.md)
2. [jarvis/src/index.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/index.ts)
3. [docs/startup-to-message-flow.md](/Users/lw/opensource/jarvis-personal-ai/docs/startup-to-message-flow.md)
4. [jarvis/src/core/agent.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/agent.ts)
5. [jarvis/src/core/memory.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/memory.ts)
6. [docs/DNI_ARCHITECTURE.md](/Users/lw/opensource/jarvis-personal-ai/docs/DNI_ARCHITECTURE.md)
7. [docs/config-reference.md](/Users/lw/opensource/jarvis-personal-ai/docs/config-reference.md)

## 排查问题时的入口建议

按问题类型，可以先看这些地方：

- 启动失败
  看 `jarvis/src/index.ts`、配置文件、环境变量。
- 模型不回复或上下文异常
  看 `agent.ts`、`agentInitializer.ts`、`systemPromptBuilder.ts`。
- 记忆召回不准
  看 `memory.ts`、`entityExtractor.ts`、相关 memory docs。
- 定时任务不执行
  看 `taskScheduler.ts`、`proactiveTaskRunner.ts`、`tasks.json`。
- 微信/飞书消息异常
  看 `channels/`、`channelRegistry.ts`。
- 子 agent 没加载
  看 `agentRegistry.ts` 和 `.gemini/agents/` 下的 `agent.json`。

## 当前理解下的总结构结论

这个项目的本质是：

- 复用 `gemini-cli` 的通用 agent/工具底座
- 在 `jarvis/` 里实现“个人长期陪伴型 AI 助手”能力
- 通过本地记忆、主动任务、外部渠道和项目内 agents/skills，把它做成一个持续运行的个人系统

所以后续看代码时，最重要的分层意识是：

- `gemini-cli/` 解决通用能力
- `jarvis/` 解决产品化和个性化能力
- `~/.gemini-jarvis/` 保存实际运行态和用户数据
