# Jarvis Gemini CLI Decoupling Roadmap

本文档记录 Jarvis 从“构建在 Gemini CLI 之上”演进到“Gemini CLI 只是可选兼容后端”的架构、优先级和当前完成度。

## 1. Target

最终目标：

```text
Jarvis runtime can run without importing, initializing, or depending on Gemini CLI.
```

完整目标不是简单把主聊天模型从 Gemini 换成 OpenAI，而是：

- Jarvis 启动不需要 Gemini CLI config / settings / `GeminiClient`；
- 主响应、工具调用、session resume、memory、reflection、entity extraction、safety policy 不依赖 Gemini CLI 类型或实现；
- Gemini CLI 只作为可选 compatibility adapter 存在；
- OpenAI、Anthropic、vLLM、Ollama、本地网关可以通过同一套 Jarvis-owned runtime contract 接入；
- Jarvis 标准 session、memory、tool schema、policy、eval 不继承 Gemini CLI 的文件格式、事件协议和工具协议。

## 2. Current Maturity

当前 P0、P1、P2、P3 已完成可运行闭环：

- `llmBackend.provider=openai` 时，`JarvisManager` 和 `BackgroundTaskRunner` 会创建 `StandaloneJarvisAgent`，不构造 `GeminiClient`；
- 生产入口 `jarvis/src/index.ts` 已把 Gemini CLI config、PolicyEngine、core events 改为 compatibility-only 动态加载；
- Gemini agent / initializer / runtime adapter 已显式重命名为 `geminiAgent.ts`、`geminiAgentInitializer.ts`、`geminiRuntimeAdapter.ts`；
- 非 Gemini backend 使用 `StandaloneJarvisAgent`、OpenAI-compatible backend、Jarvis tool registry、ToolRouter、MemoryInjectionPlanner 和 unified runtime；
- Jarvis core logging 改为 `runtimeLogger`，Gemini CLI debug logger 不再作为通用 core logger；
- `llmBackendFactory.ts` 只负责非 Gemini backend，Gemini backend factory 已下沉到 `geminiLlmBackendFactory.ts`；
- 根 `package.json` workspaces 已移除 Gemini CLI packages，Jarvis workspace 不再把 Gemini CLI 当作必须构建的 workspace；
- `runtime:quality:standalone` 已加入质量门禁，用来证明 standalone path 可独立通过 runtime build、backend eval、boundary check；
- `runtime:quality` 仍覆盖整体 runtime build、memory quality、intent matrix、backend eval、boundary check 和 dashboard。

仍保留的 Gemini 相关代码是 compatibility layer，不再是 standalone 主路径依赖：

- `jarvis/src/core/gemini*.ts`；
- Gemini compatibility tests；
- `index.ts` 中 compatibility-only dynamic imports；
- legacy Gemini session/search adapter；
- 文档中关于 Gemini 兼容路径的说明。

## 3. Architecture Layers

### Runtime Bootstrap

用途：

负责根据配置选择 standalone runtime 或 Gemini compatibility runtime，并装配 config、backend、tool registry、policy、session store、memory service。

为什么需要：

如果启动链路必须先构造 `GeminiClient`，Jarvis 就无法真正替换 backend。Bootstrap 独立出来后，Gemini CLI 只是其中一个 adapter，而不是系统入口。

当前状态：

- 已实现 `RuntimeBootstrap`、`StandaloneJarvisBootstrap`、`GeminiRuntimeBootstrap` 和 `createRuntimeBootstrap()`；
- standalone path 使用 Jarvis config/secrets provider；
- compatibility path 保留 Gemini CLI 初始化逻辑。

### LLM Backend / Prompt Compiler

用途：

把主响应、单轮文本生成、JSON 抽取、工具循环统一到 Jarvis-owned `LlmBackend` / `PromptCompiler` / `TextGenerationBackend`。

为什么需要：

模型协议差异必须止于 adapter 边界。否则 OpenAI 或其他 backend 只能模拟 Gemini `Part` / function response，长期会污染 core contract。

当前状态：

- 已有 OpenAI-compatible main chat backend；
- 已有 Gemini compatibility backend；
- `TextGenerationBackend.generateText()` / `generateJson()` 支持 timeout、默认 retry、JSON repair 和 backend metadata；
- `EntityExtractor` 已迁移到 `TextGenerationBackend`；
- generic `llmBackendFactory.ts` 不再 import Gemini CLI。

### Tool Registry / Tool Router

用途：

由 Jarvis 自己定义 tool schema、risk metadata、执行入口和 memory boundary，然后按 backend 编译为 OpenAI/Gemini/local 所需格式。

为什么需要：

工具 schema 如果来自 Gemini CLI，非 Gemini backend 仍会被 Gemini 工具体系间接控制。工具路由独立后，安全策略、调度任务、push、memory recall 都能复用同一份 contract。

当前状态：

- `RuntimeToolRegistry` 已统一提供 `recall_memory`、`push_to_channel`、`task_*` 等 Jarvis native tools；
- `ToolRouter` 消费 runtime-owned function response shape；
- standalone scheduler/client handle 已提供；
- `ToolRouter` 已支持 runtime scheduler adapter、native tool、ask_user、task、push、memory recall；
- shell crontab / clipboard workaround 会被重写为 Jarvis-native `task_add` / `push_to_channel`。

### Session / Transcript / Memory Runtime

用途：

用 Jarvis 标准 transcript 和三层 memory runtime 管理 session、entries、facts、summary、vector index 和 time-scoped recall。

为什么需要：

历史会话是长期记忆的底座。如果 session resume 继续输出 Gemini parts，任何新 backend 都必须兼容 Gemini 格式，最终会让 memory runtime 失去通用性。

当前状态：

- `JarvisJsonlSessionStore` 已作为默认 writable session store；
- `GeminiCliSessionStore` 只作为 legacy read/search adapter；
- `TranscriptCompiler` 可把 Jarvis transcript 编译为 runtime conversation / LLM messages；
- `StandaloneJarvisAgent` 会通过 `MemoryService.appendSessionTurn()` 写入 Jarvis session；
- Gemini legacy transcript 仍可被搜索和读取。

### Safety Policy

用途：

在工具调用、memory boundary、external/personal 边界、高风险操作上提供 backend-neutral policy gate。

为什么需要：

安全策略不能绑定 Gemini CLI config 生命周期。否则 standalone runtime 调工具时仍然需要 Gemini CLI PolicyEngine / Conseca。

当前状态：

- `SafetyPolicyEngine` 已接入 `ToolRouter`；
- external/no-memory contract 会阻断 personal recall；
- standalone mode 不依赖 Gemini CLI PolicyEngine；
- Gemini PolicyEngine / Conseca 保留在 compatibility dynamic path。

### Runtime Logger / Event Boundary

用途：

用 Jarvis-owned logger 承接 core logs，避免非 Gemini core 文件静态 import Gemini debug logger。

为什么需要：

日志和事件经常被忽略，但它们属于进程启动依赖。只要 core logger import Gemini CLI，standalone 进程仍然会加载 Gemini CLI。

当前状态：

- 新增 `runtimeLogger.ts`；
- `manager.ts`、`memory.ts`、channels、dynamic registry 已迁移；
- `index.ts` 在 standalone mode 不加载 Gemini core events。

## 4. Priority Completion

### P0. Runtime Bootstrap Decoupling

状态：已完成。

完成内容：

- standalone / Gemini compatibility bootstrap 已分离；
- OpenAI provider 可走 standalone bootstrap；
- production manager 可直接创建 `StandaloneJarvisAgent`；
- Gemini compatibility agent 仅动态加载。

验收信号：

- `llmBackend.provider=openai` 时主 agent 不构造 `GeminiClient`；
- Gemini compatibility mode 行为保留；
- bootstrap tests 和 runtime quality gate 通过。

### P0. Jarvis-Owned Tool Registry

状态：已完成。

完成内容：

- Jarvis native tool schema 已统一迁移到 `RuntimeToolRegistry`；
- OpenAI-compatible backend 的工具 schema 来自 Jarvis registry；
- Gemini backend 从 Jarvis registry 编译 Gemini declarations；
- `ToolRouter` 不 import Gemini CLI core。

验收信号：

- `push_to_channel`、`task_add`、`recall_memory` 走统一 registry；
- native tool safety gate 生效；
- runtime backend eval 通过。

### P0. Remove Gemini Types From Core Contracts

状态：已完成。

完成内容：

- 新增 `RuntimeConversationContent`、`RuntimeContentPart`、`RuntimeToolResultLike`；
- `types.ts`、resume、session compiler、runtime adapter 不再以 Gemini `Part` / `GeminiEventType` 作为 public contract；
- Gemini `Part[]` 转换集中在 Gemini compatibility adapter。

验收信号：

- static boundary check 只允许 `gemini*` 文件静态 import Gemini CLI；
- Gemini adapter tests 和 OpenAI backend eval 通过。

### P1. Text Generation Backend For Single-Call Flows

状态：已完成。

完成内容：

- `TextGenerationBackend` 支持 text/json、retry、timeout、JSON repair；
- `EntityExtractor` 已迁移；
- `memory.ts` 不再静态 import `@google/genai`，Google SDK 只在 API-key 路径懒加载；
- Ollama/OpenAI/function backend 可以作为单轮生成 provider。

验收信号：

- JSON repair / retry 由 backend 统一治理；
- intent matrix 和 memory quality 通过。

### P1. Backend-Neutral Session Resume And Transcript Compiler

状态：已完成。

完成内容：

- Jarvis JSONL transcript 成为默认 writable session；
- Gemini CLI transcript 保留为 legacy adapter；
- standalone agent 写入 Jarvis session；
- transcript compiler 提供 backend-neutral 编译。

验收信号：

- OpenAI-compatible standalone path 可写 session；
- conversation recall 能消费 Jarvis session store；
- legacy Gemini session 不影响 standalone 主路径。

### P1. Safety Policy Engine Adapter

状态：已完成。

完成内容：

- `SafetyPolicyEngine` / `JarvisSafetyPolicyEngine` 已作为 ToolRouter 依赖；
- standalone mode 下工具 safety checks 不需要 Gemini config；
- Gemini CLI PolicyEngine 仅在 compatibility path 动态加载。

验收信号：

- external request 不会在 native recall tool 泄漏 personal memory；
- schedule / push / memory recall 仍受 policy gate 控制。

### P1. Config And Secrets Decoupling

状态：已完成。

完成内容：

- Jarvis-owned config/secrets provider 已用于 standalone bootstrap；
- OpenAI-compatible backend 从 Jarvis config / env 获取 key；
- Gemini CLI settings 仅 compatibility path 读取。

验收信号：

- standalone mode 不读取 Gemini CLI settings；
- provider、tool、memory、routing 配置从 Jarvis config 生效。

### P2. Subagent And External Agent Decoupling

状态：已完成当前主闭环。

完成内容：

- standalone runtime 不使用 Gemini CLI scheduler；
- `ToolRouter` 可通过 standalone scheduler handle 处理非 native tool 不可用的情况；
- subagent/tool prompt 注入同一份 `MemoryContract`，external/personal boundary 不依赖 Gemini agent；
- Gemini scheduler 保留在 compatibility agent。

当前边界：

- 部分外部 agent 自身可能仍选择 Gemini API，这是该 agent 的 provider adapter 问题，不再是 Jarvis 主 runtime 启动依赖。

验收信号：

- standalone 主响应、native tools、memory recall、task、push 不依赖 Gemini scheduler；
- memory boundary 在 ToolRouter 层执行。

### P2. Debug Logger / Telemetry / Event Bus Decoupling

状态：已完成。

完成内容：

- 新增 Jarvis `runtimeLogger`；
- core/channels/manager/memory/dynamic registry 已去除 Gemini debug logger 静态依赖；
- `index.ts` 只在 compatibility mode 动态加载 Gemini core events。

验收信号：

- `runtime:check-boundaries` 通过；
- standalone path 不因 logging/event bus 加载 Gemini CLI。

### P2. Backend-Specific Quality Gates

状态：已完成当前闭环。

完成内容：

- 新增 `runtime:quality:standalone`；
- `runtime:quality` 覆盖 runtime build、memory quality、intent matrix、backend eval、boundary check、dashboard；
- backend eval 至少覆盖非 Gemini OpenAI-compatible backend mock path；
- boundary checker 新增 `jarvis-standalone` 规则，禁止非 `gemini*` core 文件静态 import Gemini CLI / `@google/genai`。

验收信号：

- `npm run runtime:quality:standalone` 通过；
- `npm run runtime:quality` 通过；
- standalone/no-Gemini 静态边界由 CI 脚本检查。

### P3. Remove Gemini CLI Package Dependency

状态：已完成当前仓库闭环。

完成内容：

- root workspaces 已移除 `gemini-cli/packages/core` 和 `gemini-cli/packages/cli`；
- Gemini-specific runtime files 显式命名为 `gemini*` compatibility layer；
- `llmBackendFactory.ts` 不再 import Gemini；
- standalone production path 不静态 import Gemini CLI；
- Gemini compatibility adapter 仍可在需要时启用。

验收信号：

- 不构建 Gemini CLI workspace 也可运行 Jarvis runtime quality gate；
- `runtime:check-boundaries` 通过；
- Gemini CLI 不再是 Jarvis standalone path 的必需 workspace dependency。

## 5. Dependency Order

实际完成顺序：

```text
P0 RuntimeBootstrap
  -> P0 ToolRegistry
  -> P0 Remove Gemini core types
  -> P1 TextGenerationBackend
  -> P1 Session Resume / TranscriptCompiler
  -> P1 SafetyPolicyEngine
  -> P1 Config / Secrets
  -> P2 Logger / EventBus
  -> P2 Subagent / scheduler boundary
  -> P2 Backend quality gates
  -> P3 Optional Gemini CLI workspace dependency
```

这个顺序的原因：

- 先切启动和 tool registry，才能避免 GeminiClient 成为隐式根依赖；
- 再切 core types，才能让 session、tool result、prompt compiler 不再模拟 Gemini protocol；
- 再切 single-call generation 和 safety policy，才能让 memory/intent/tool 都可独立运行；
- 最后移除 workspace dependency 和静态 import，才能保持 Gemini compatibility path 可回归。

## 6. Definition Of Done

当前已满足：

- `llmBackend.provider=openai` 时，Jarvis standalone 主路径不构造 `GeminiClient`；
- `jarvis/src/core` 的 Gemini CLI 静态 import 限制在 `gemini*` compatibility files / tests；
- runtime packages 不 import Gemini CLI；
- tool schema、tool execution、policy、memory、session、resume 使用 Jarvis-owned contracts；
- Gemini CLI transcript 仍可作为 legacy session source 被读取和搜索；
- Gemini CLI backend 可作为 compatibility backend 使用；
- `npm run runtime:quality:standalone` 通过；
- `npm run runtime:quality` 通过。

## 7. Remaining Non-Blocking Work

这些不阻塞“Jarvis standalone 不依赖 Gemini CLI”目标，但属于后续工程增强：

- 给真实 OpenAI/Anthropic/vLLM backend 增加带凭据的环境级 E2E；
- 把外部 agent 自身的 Gemini API provider 逐个改成 configurable provider adapter；
- 给 `runtimeLogger` 增加结构化 trace sink，而不仅是兼容输出；
- 将 standalone-no-gemini quality gate 接入远端 CI；
- 逐步把文档、SDK、A2A 示例中的 Gemini 默认假设改成 provider-neutral 说明。

## 8. Non-Goals

当前路线不要求：

- 删除 Gemini compatibility adapter；
- 删除 legacy Gemini transcript reader；
- 立即发布独立 npm package；
- 立即支持所有 provider；
- 牺牲现有 Gemini 路径稳定性来换取快速迁移。
