# Jarvis Gemini CLI Decoupling Roadmap

本文档记录 Jarvis 最终不再依赖 Gemini CLI 所需的前置工作、优先级、验收标准和依赖关系。

## 1. Target

最终目标：

```text
Jarvis runtime can run without importing, initializing, or depending on Gemini CLI.
```

这不是简单把主聊天模型从 Gemini 换成 OpenAI。完整目标包括：

- Jarvis 启动不需要 Gemini CLI config / settings / `GeminiClient`；
- 主响应、工具调用、session resume、memory、reflection、entity extraction、safety policy 都不依赖 Gemini CLI 类型或实现；
- Gemini CLI 只作为可选兼容 adapter 存在；
- 其他 backend，例如 OpenAI、Anthropic、vLLM、Ollama、本地网关，可以通过同一套 Jarvis-owned runtime contract 接入；
- Jarvis 标准 session、memory、tool schema、policy、eval 不继承 Gemini CLI 的文件格式、事件协议和工具协议。

## 2. Current State

已经完成的基础：

- `packages/agent-runtime` 已有 backend-neutral `LlmBackend`、`PromptCompiler`、`ToolLoopRuntime`；
- Jarvis 主响应 loop 已通过 `AgentRuntime.handleTurn()` 执行；
- 已有 `GeminiCliBackendAdapter` 和 OpenAI-compatible backend；
- `packages/memory-runtime` 已有三层 memory runtime、SQLite store、`SessionStore`、标准 `JarvisJsonlSessionStore`；
- intent runtime、memory runtime、execution contract 已基本脱离 Gemini protocol；
- `runtime:quality` 已覆盖 runtime build、memory quality、intent matrix、backend eval、boundary check。

仍然存在的 Gemini CLI 硬依赖：

- `jarvis/src/index.ts` 仍 import Gemini CLI config、PolicyEngine、core events；
- `jarvis/src/core/agentInitializer.ts` 仍创建 `GeminiClient`、加载 Gemini CLI config/settings、处理 Gemini session context；
- `jarvis/src/core/toolRouter.ts` 仍 import Gemini CLI core 类型和工具体系；
- `jarvis/src/core/types.ts`、`resumeFromDisk.ts`、`jarvisRuntimeAdapter.ts` 仍泄漏 Gemini `Part` / `GeminiEventType`；
- `jarvis/src/core/memory.ts` 的 reflection / entity extraction / debug logger 仍可走 Gemini；
- safety / policy / Conseca 检查仍绑定 Gemini CLI config 生命周期；
- 部分 subagent / A2A / SDK / docs 仍假设 Gemini API、Gemini OAuth 或 Gemini CLI home 目录。

## 3. Priority Plan

### P0. Runtime Bootstrap Decoupling

目的：

让 Jarvis 进程启动不再必须构造 Gemini CLI config 和 `GeminiClient`。

需要做：

- 新增 `RuntimeBootstrap` 接口，描述 Jarvis 启动后主流程需要的能力：
  - config；
  - model backend factory；
  - tool registry；
  - policy engine；
  - session store；
  - skill registry；
  - telemetry / event bus。
- 新增 `GeminiCliBootstrapAdapter`，封装当前 Gemini CLI 初始化路径。
- 新增 `StandaloneJarvisBootstrap`，只使用 Jarvis config 和 runtime packages，不初始化 Gemini CLI。
- `jarvis/src/index.ts` 从直接调用 Gemini CLI config 改为选择 bootstrap adapter。
- `agentInitializer.ts` 收缩为 Gemini compatibility bootstrap，不再是 Jarvis 唯一启动入口。

为什么优先：

只要启动链路必须构造 `GeminiClient`，Jarvis 就无法真正脱离 Gemini CLI。主聊天 backend 即使切到 OpenAI，也只是表层替换。

验收标准：

- `llmBackend.provider=openai` 时可以启动 Jarvis 而不构造 `GeminiClient`；
- Gemini compatibility mode 行为不变；
- runtime quality gate 通过；
- 新增 bootstrap tests 覆盖 Gemini adapter 和 standalone adapter。

### P0. Jarvis-Owned Tool Registry

目的：

工具 schema 和工具执行必须归 Jarvis/runtime 所有，而不是从 Gemini client 提取。

需要做：

- 新增 `ToolRegistry` / `RuntimeToolRegistry`：
  - tool name；
  - description；
  - JSON schema；
  - risk level；
  - execution handler；
  - memory contract requirements；
  - capability tags。
- `ToolRouter` 改为消费 Jarvis-owned registry。
- `llmBackendFactory` 不再从 Gemini client 提取 tool declarations。
- Gemini backend adapter 把 Jarvis tool schema 编译为 Gemini function declarations。
- OpenAI / Anthropic / local backend 也从同一份 registry 编译工具定义。
- 保留 Gemini CLI tool declaration import 作为 compatibility loader，而不是主来源。

为什么优先：

工具调用是 agent 可靠性的核心。如果 tool schema 仍来自 Gemini CLI，非 Gemini backend 会继续间接依赖 Gemini 工具体系，且执行契约无法完全统一。

验收标准：

- `ToolRouter` 不 import Gemini CLI core；
- OpenAI backend 的工具 schema 来自 Jarvis registry；
- Gemini backend 从 Jarvis registry 编译 Gemini tool declarations；
- execution-contract eval 全部通过；
- `push_to_channel`、`task_add`、`recall_memory`、file/shell/subagent tools 均通过统一 registry 暴露。

### P0. Remove Gemini Types From Core Contracts

目的：

Gemini `Part`、`GeminiEventType`、`functionResponse` 只能存在于 Gemini adapter 边界。

需要做：

- 用 runtime-owned 类型替换 core 中的 Gemini 类型：
  - `LlmMessage`；
  - `RuntimeToolRequest`；
  - `RuntimeToolResult`；
  - `RuntimeContentBlock`；
  - `RuntimeConversationTurn`。
- `jarvis/src/core/types.ts` 不再 import Gemini `Part`。
- `resumeFromDisk.ts` 改为读取 `SessionStore` transcript，再由 backend-specific `TranscriptCompiler` 编译。
- `jarvisRuntimeAdapter.ts` 不再 import `GeminiEventType`，只处理 runtime event。
- Gemini `Part[]` 转换逻辑集中保留在 `geminiBackendAdapter.ts`。

为什么优先：

类型泄漏会把 provider protocol 固化为系统架构。只要 core contract 仍使用 Gemini 类型，其他 backend 只能做兼容模拟，无法成为一等 backend。

验收标准：

- `rg "type Part|GeminiEventType|functionResponse" jarvis/src/core` 只命中 Gemini adapter / Gemini tests；
- resume/replay tests 通过；
- Gemini backend adapter tests 和 OpenAI backend tests 通过。

### P1. Text Generation Backend For Single-Call Flows

目的：

memory reflection、fact consolidation、entity extraction、summarization、JSON extractors 不再硬编码 Gemini/Ollama 二分。

需要做：

- 新增 `TextGenerationBackend`：
  - `generateText()`；
  - `generateJson()`；
  - timeout / retry；
  - JSON repair；
  - model metadata；
  - observability。
- 将这些流程迁移到该接口：
  - `MemoryService.consolidateFacts`；
  - reflection / insight generation；
  - `EntityExtractor`；
  - session summarizer；
  - focused intent extractors；
  - local router query rewrite。
- 支持 provider：
  - OpenAI-compatible；
  - Ollama；
  - Gemini adapter；
  - mock/test backend。

为什么需要：

主聊天换 backend 后，如果后台记忆和抽取流程仍调用 Gemini，就只是“部分替换”。这些单轮流程也是最适合先脱离 Gemini 的区域。

验收标准：

- `memory.ts` 不直接 import `@google/genai`；
- `EntityExtractor` 不再只接受 `"ollama" | "gemini"`；
- JSON repair / retry rate 可按 backend 统计；
- memory tests 和 intent matrix 通过。

### P1. Backend-Neutral Session Resume And Transcript Compiler

目的：

历史会话保存、搜索、恢复和 replay 使用 Jarvis 标准 transcript，而不是 Gemini CLI message format。

需要做：

- 将 `JarvisJsonlSessionStore` 作为默认 writable session store；
- Gemini CLI chat files 只作为 legacy read/search adapter；
- 新增 `TranscriptCompiler`：
  - Jarvis transcript -> OpenAI messages；
  - Jarvis transcript -> Anthropic messages；
  - Jarvis transcript -> Gemini parts；
  - Jarvis transcript -> local model prompt。
- `resumeFromDisk.ts` 改为 backend-neutral resume；
- 工具调用结果 replay 统一使用 `RuntimeToolResult`。

为什么需要：

如果 session resume 仍输出 Gemini parts，那么新 backend 在历史恢复阶段仍要模拟 Gemini 格式，长期会造成协议污染。

验收标准：

- 新会话默认写入 Jarvis JSONL v1；
- OpenAI backend 可从同一份 transcript resume；
- Gemini legacy transcript 仍可被搜索和兼容读取；
- time-scoped conversation recall tests 通过。

### P1. Safety Policy Engine Adapter

目的：

安全检查和工具调用 policy 不再绑定 Gemini CLI `PolicyEngine` / Conseca config。

需要做：

- 新增 `SafetyPolicyEngine` 接口：
  - `checkPrompt`；
  - `checkToolCall`；
  - `checkToolResult`；
  - `checkResponse`。
- 新增 `GeminiCliPolicyAdapter`，兼容当前 PolicyEngine / Conseca。
- 新增 `JarvisPolicyEngine`，基于 Jarvis runtime policy、tool risk、memory boundary 和 user approval。
- `ToolRouter` / runtime tool loop 只调用 `SafetyPolicyEngine`。
- 将 `Conseca check failed: Config not initialized` 这类路径变为 adapter 内部问题，不影响 standalone runtime。

为什么需要：

不抽 safety policy，就无法独立运行工具调用和高风险 action。非 Gemini backend 不能依赖 Gemini CLI 的 config 生命周期。

验收标准：

- standalone mode 下 policy checks 不需要 Gemini config；
- tool safety tests 通过；
- destructive tool / schedule / channel push / shell command 仍受 policy gate 控制。

### P1. Config And Secrets Decoupling

目的：

Jarvis 配置、secret、OAuth、proxy 和 runtime home 目录不再依赖 `.gemini` 或 Gemini CLI settings。

需要做：

- 定义 Jarvis-owned config schema：
  - model backend；
  - text generation backend；
  - tools；
  - channels；
  - memory；
  - safety policy；
  - proxy；
  - telemetry。
- `.gemini-jarvis/config.json` 成为 Jarvis 主配置。
- Gemini CLI settings 只在 compatibility bootstrap 中读取。
- secret 通过 env / keychain / provider-specific config 获取。

为什么需要：

配置层如果继续从 Gemini CLI 读取，会让 standalone Jarvis 无法独立部署，也会让 backend 切换逻辑分散。

验收标准：

- standalone mode 不读取 Gemini CLI settings；
- proxy / model / tool / memory 配置均从 Jarvis config 生效；
- config migration test 覆盖 legacy Gemini mode。

### P2. Subagent And External Agent Decoupling

目的：

subagent orchestration 不再默认使用 Gemini API / OAuth / Gemini CLI scheduler。

需要做：

- 将 subagent execution 抽成 `SubagentRuntime`：
  - local process agent；
  - A2A agent；
  - Python agent；
  - LLM-backed agent；
  - MCP/server agent。
- subagent prompt 使用统一 `RuntimeContext` 和 `MemoryContract`；
- subagent backend 可配置，不默认继承主 backend；
- investment-analysis 等 agent 的 Gemini API 调用改为 provider adapter。

为什么放 P2：

这不阻塞主 Jarvis 脱离 Gemini CLI 启动和主响应，但会影响完整生态能力。

验收标准：

- subagent 不直接读取 Gemini OAuth；
- external/personal memory boundary 在 subagent 层仍通过；
- investment-analysis 可选择 OpenAI-compatible 或 Gemini adapter。

### P2. Debug Logger / Telemetry / Event Bus Decoupling

目的：

日志、telemetry、core events 不再 import Gemini CLI debug logger 或 core events。

需要做：

- 新增 Jarvis `Logger` / `RuntimeEventBus`；
- Gemini CLI debug logger 作为 adapter；
- runtime packages 只暴露 observer/event；
- `jarvis/src/index.ts`、`manager.ts`、`channels/wechat.ts` 不直接 import Gemini debug logger。

验收标准：

- core logging 不 import Gemini CLI；
- runtime dashboard 仍能聚合 events；
- existing log format 尽量保持兼容。

### P2. Backend-Specific Quality Gates

目的：

证明不同 backend 不只是能跑，而是满足 Jarvis 的安全和质量要求。

需要做：

- 扩展 backend eval：
  - OpenAI main chat；
  - Anthropic main chat；
  - local planner-only；
  - Gemini compatibility。
- 每个 backend 统计：
  - tool call success rate；
  - retry rate；
  - JSON repair rate；
  - memory injection boundary pass rate；
  - latency；
  - token / cost；
  - success-claim correctness。
- `runtime:quality` 增加 backend matrix mode。

验收标准：

- 至少一个非 Gemini backend 通过完整 runtime quality；
- failure samples 自动进入 feedback candidate；
- backend 切换有明确 pass/fail 报告。

### P3. Remove Gemini CLI Package Dependency

目的：

完成最终收口：Gemini CLI 不再是 Jarvis 必需依赖。

需要做：

- package dependency 中 Gemini CLI 相关依赖变为 optional；
- Gemini compatibility adapter 可独立安装或 feature flag 启用；
- CI 增加 `standalone-no-gemini` job；
- `rg "gemini-cli" jarvis/src packages/runtime` 只允许命中文档、adapter、legacy tests；
- 清理或迁移 SDK / A2A 中不再需要的 Gemini-specific paths。

为什么最后做：

过早移除依赖会让兼容路径和回归测试失效。应先让 standalone path 完整通过，再把 Gemini CLI 降级为 optional adapter。

验收标准：

- 不安装 / 不初始化 Gemini CLI 时 Jarvis 能启动、聊天、调用工具、召回记忆、写 session；
- Gemini compatibility adapter 可选启用；
- standalone CI 通过；
- runtime quality gate 通过。

## 4. Dependency Order

推荐执行顺序：

```text
P0 RuntimeBootstrap
  -> P0 ToolRegistry
  -> P0 Remove Gemini core types
  -> P1 TextGenerationBackend
  -> P1 Session Resume / TranscriptCompiler
  -> P1 SafetyPolicyEngine
  -> P1 Config / Secrets
  -> P2 SubagentRuntime
  -> P2 Logger / EventBus
  -> P2 Backend quality matrix
  -> P3 Optional Gemini CLI dependency
```

关键依赖：

- `ToolRegistry` 依赖 `RuntimeBootstrap` 提供 registry 装配入口；
- `Remove Gemini core types` 依赖 `ToolRegistry`，否则工具结果 replay 仍会回到 Gemini `Part`；
- `TextGenerationBackend` 可以和 `Session Resume` 并行；
- `SafetyPolicyEngine` 需要先有 `ToolRegistry` 的 risk metadata；
- `Optional Gemini CLI dependency` 必须最后做。

## 5. Definition Of Done

完整完成后应满足：

- `llmBackend.provider=openai` 或其他非 Gemini backend 时，Jarvis 启动不构造 `GeminiClient`；
- `jarvis/src/core` 不直接 import Gemini CLI，除 `gemini*Adapter.ts` 和 legacy tests；
- runtime packages 不 import Gemini CLI；
- Tool schema、tool execution、policy、memory、session、resume 全部使用 Jarvis-owned contracts；
- Gemini CLI transcript 仍可作为 legacy session source 被读取和搜索；
- Gemini CLI backend 仍可作为 optional compatibility backend 使用；
- `npm run runtime:quality` 通过；
- 新增 `runtime:quality:standalone` 或等价 CI job 通过；
- 至少一个非 Gemini backend 通过主响应 + tool loop + memory recall 的端到端验证。

## 6. Non-Goals

当前路线不要求：

- 立刻删除 Gemini compatibility adapter；
- 立刻重写所有外部 agent；
- 立刻发布独立 npm package；
- 立刻支持所有 provider；
- 牺牲现有 Gemini 路径稳定性来换取快速迁移。

## 7. Recommended Next Step

下一步优先实现：

```text
P0 Runtime Bootstrap Decoupling
```

原因：

- 它是“Jarvis 不再依赖 Gemini CLI”的根；
- 不完成它，其他 backend 只能作为 Gemini CLI 初始化后的替代模型；
- 完成后可以用 feature flag 同时保留 Gemini compatibility 和 standalone Jarvis 两条启动路径。
