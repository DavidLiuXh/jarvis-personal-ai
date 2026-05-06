# Jarvis 源码阅读指南

这份文档不是完整设计文档，而是“如何最快看懂这个仓库”的阅读路径。

目标只有两个：

1. 尽快建立正确分层认知
2. 需要定位问题时知道先看哪个文件

## 先建立一个总模型

阅读这个仓库前，先记住三层：

1. `gemini-cli/`
   通用底座，负责模型客户端、调度器、工具执行、CLI/UI 等。
2. `jarvis/`
   Jarvis 的产品化定制层，负责长期记忆、渠道接入、主动任务、个性化 prompt 等。
3. `~/.gemini-jarvis/`
   运行态数据目录，保存配置、任务、记忆库、运行时文件。

如果这个分层没有先建立，后面很容易看着看着就混掉：

- 什么是上游现成能力
- 什么是 Jarvis 自己扩出来的能力
- 什么是运行时数据而不是源码

## 推荐阅读顺序

### 第 1 步：先看项目定位

先读：

- [README.md](/Users/lw/opensource/jarvis-personal-ai/README.md)
- [docs/project-structure-overview.md](/Users/lw/opensource/jarvis-personal-ai/docs/project-structure-overview.md)

要回答的问题：

- 这是个什么产品
- 依赖什么底座
- 主要能力边界是什么

如果这一步没做，后面会把很多实现误判成“普通聊天机器人逻辑”，而这个项目实际重点是“长期运行的个人 AI 系统”。

### 第 2 步：理解启动主链路

接着读：

- [jarvis/src/index.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/index.ts)
- [docs/startup-to-message-flow.md](/Users/lw/opensource/jarvis-personal-ai/docs/startup-to-message-flow.md)

重点看清楚：

- 启动时读了哪些配置
- 为什么会切换到 `~/.gemini-jarvis/runtime`
- HTTP / WebSocket / WeChat / Feishu / TaskScheduler 是怎么挂起来的
- 一条用户消息最后怎么进入 `JarvisAgent`

这一步的目标不是记细节，而是建立“从进程启动到收到消息”的骨架。

### 第 3 步：看会话代理本体

然后看：

- [jarvis/src/core/manager.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/manager.ts)
- [jarvis/src/core/agent.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/agent.ts)

推荐抓这几个问题去读：

- `JarvisAgent` 是何时创建的
- 同一个 session 怎么复用
- 首次初始化和后续消息处理有什么区别
- system prompt 在哪一层刷新
- 工具调用循环在哪里发生
- 一轮回答结束后有哪些异步善后逻辑

这里是最值得花时间的文件，因为大部分行为都从这里穿过去。

### 第 4 步：看初始化和工具装配

继续读：

- [jarvis/src/core/agentInitializer.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/agentInitializer.ts)
- [jarvis/src/core/toolRouter.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/toolRouter.ts)
- [jarvis/src/core/dynamicToolRegistry.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/dynamicToolRegistry.ts)

这里要搞清楚：

- Jarvis 是怎么接上 gemini-cli 的 `GeminiClient` 和 `Scheduler`
- 哪些工具是 Jarvis 原生能力
- 哪些调用会下沉到上游 scheduler
- 动态工具和扩展能力是怎么注册进来的

如果你以后要加新工具，这一层必须熟。

### 第 5 步：重点啃记忆系统

然后再看：

- [jarvis/src/core/memory.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/memory.ts)
- [jarvis/src/core/systemPromptBuilder.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/systemPromptBuilder.ts)
- [jarvis/src/core/backgroundDistiller.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/backgroundDistiller.ts)
- [jarvis/src/core/entityExtractor.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/entityExtractor.ts)
- [jarvis/src/core/sessionSummarizer.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/sessionSummarizer.ts)

配套文档一起看：

- [docs/DNI_ARCHITECTURE.md](/Users/lw/opensource/jarvis-personal-ai/docs/DNI_ARCHITECTURE.md)
- [docs/dni-memory-system.md](/Users/lw/opensource/jarvis-personal-ai/docs/dni-memory-system.md)
- [docs/memory-system-deep-dive.md](/Users/lw/opensource/jarvis-personal-ai/docs/memory-system-deep-dive.md)

读这一块时，建议按下面顺序理解：

1. 数据存在哪里
2. facts 和 memories 分别是什么
3. embeddings、FTS、entity links 分别干什么
4. 一条对话结束后如何进入记忆系统
5. 下一轮提问时如何把记忆重新召回进 prompt

这是 Jarvis 的差异化核心，值得单独花时间。

### 第 6 步：看主动任务和外部渠道

接着看：

- [jarvis/src/core/taskScheduler.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/taskScheduler.ts)
- [jarvis/src/core/proactiveTaskRunner.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/proactiveTaskRunner.ts)
- [jarvis/src/core/taskCommandHandler.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/taskCommandHandler.ts)
- [jarvis/src/core/channels/wechat.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/channels/wechat.ts)
- [jarvis/src/core/channels/feishu.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/channels/feishu.ts)
- [jarvis/src/core/channelRegistry.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/channelRegistry.ts)

这一层主要回答：

- 定时任务是如何保存和触发的
- 主动推送结果时为什么需要 channel registry
- 外部消息是如何进入统一主链路的

如果你的关注点是“它怎么从聊天工具变成主动助手”，这块最关键。

### 第 7 步：最后再看扩展体系

最后看：

- [jarvis/src/core/agentRegistry.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/agentRegistry.ts)
- [.gemini/agents](/Users/lw/opensource/jarvis-personal-ai/.gemini/agents)
- [.gemini/skills](/Users/lw/opensource/jarvis-personal-ai/.gemini/skills)
- [.gemini/commands](/Users/lw/opensource/jarvis-personal-ai/.gemini/commands)

这一步主要理解：

- 子 agent 是怎么发现和加载的
- 项目级 skill / command 资源是怎么组织的
- 哪些扩展是 repo 内版本化的，哪些是用户目录级的

## 如果你时间很少，只读这 6 个文件

最小高价值阅读集合：

1. [jarvis/src/index.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/index.ts)
2. [jarvis/src/core/agent.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/agent.ts)
3. [jarvis/src/core/memory.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/memory.ts)
4. [jarvis/src/core/toolRouter.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/toolRouter.ts)
5. [jarvis/src/core/taskScheduler.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/taskScheduler.ts)
6. [jarvis/src/core/channels/wechat.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/channels/wechat.ts)

看完这 6 个文件，已经足够对系统轮廓有基本判断。

## 按任务目标来读

如果你不是系统学习，而是带着任务来，建议按目标切。

### 想改回复行为

优先看：

- `agent.ts`
- `systemPromptBuilder.ts`
- `toolRouter.ts`

### 想改长期记忆效果

优先看：

- `memory.ts`
- `backgroundDistiller.ts`
- `entityExtractor.ts`
- `sessionSummarizer.ts`

### 想加新工具或新技能

优先看：

- `agentInitializer.ts`
- `dynamicToolRegistry.ts`
- `.gemini/skills/`

### 想改主动任务或提醒

优先看：

- `taskScheduler.ts`
- `proactiveTaskRunner.ts`
- `taskCommandHandler.ts`

### 想排查微信/飞书问题

优先看：

- `channels/wechat.ts`
- `channels/feishu.ts`
- `index.ts`
- `channelRegistry.ts`

### 想加子 agent

优先看：

- `agentRegistry.ts`
- `.gemini/agents/*/agent.json`

## 阅读时容易踩的坑

### 不要把运行态数据当源码结构的一部分

很多关键配置和数据不在 repo 内，而在：

- `~/.gemini-jarvis/config.json`
- `~/.gemini-jarvis/tasks.json`
- `~/.gemini-jarvis/memory/`

如果只盯着仓库代码，会误以为某些行为“没有来源”。

### 不要一开始就钻进 `gemini-cli/`

除非你已经确认问题发生在上游底座，否则先把 `jarvis/` 主链路读顺。

这个仓库的大多数业务理解成本，不在上游，而在 Jarvis 自己叠加的产品逻辑。

### 不要把“会话历史”和“长期记忆”混为一谈

当前系统明显做了区分：

- 当前 chat history
- 历史摘要
- facts
- vec memories
- entity graph

如果把这些都当成同一种“memory”，会很难看懂实际召回策略。

## 推荐的阅读方法

最省时间的方法不是逐文件线性读完，而是：

1. 先抓主流程
2. 再按能力分块下钻
3. 最后只在需要时进入 `gemini-cli/` 对应实现

实操上建议这样做：

1. 先用 `index.ts -> manager.ts -> agent.ts` 建主链
2. 再按“记忆 / 工具 / 任务 / 渠道”拆块
3. 每块只回答一个问题，不要一次想全懂

## 一句话阅读结论

这个仓库最正确的阅读方式，不是把它当成一个普通 Node 项目逐目录看，而是把它当成：

- 一个以 `JarvisAgent` 为中心的消息处理系统
- 一个以 `MemoryService` 为核心差异化能力的长期记忆系统
- 一个建立在 `gemini-cli` 之上的产品化封装层

只要先抓住这三点，后面读代码会快很多。
