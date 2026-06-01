# Intent-Driven Runtime Roadmap

本文档记录 Jarvis 将当前 intent / memory / clarification / execution 能力抽成独立 runtime 层的下一步工作拆解。

## Current State

当前实现已经具备一套可运行的通用层雏形：

- `packages/memory-runtime/src` 已承载 `IntentFrame`、`MemoryContract`、`ClarificationQuestion`、memory policy、clarification policy、retrieval adapter、injection planner 和 `DefaultMemoryRuntime`。
- `packages/intent-runtime/src` 已承载 `IntentExecutionPlan`、`IntentStepRuntime` 和 tool-backed execution contract 纯逻辑。
- `jarvis/src/memory-runtime/*` 与 `jarvis/src/intent-runtime/*` 现在是兼容 re-export shim，便于现有 Jarvis import 平滑过渡。
- runtime packages 基本没有反向依赖 `jarvis/src/core/*`，具备继续独立化的基础。
- `agent.ts#runUnifiedRuntimeTurn()` 已通过 `AgentRuntime.handleTurn()` 执行主响应路径的 `intent -> memory -> skill -> response compose -> LLM/tool loop`。
- `DefaultMemoryRetriever` 已支持 `session / fact / entry` 三层 store adapter，并通过 extension points 保留 Jarvis 的 query rewrite、recent conversation recall、summary fallback。
- intent eval 已从单点回归 case 演进为 principle / invariant / semantic axis 矩阵。

当前剩余缺口也很明确：

- `IntentResolver` 仍是 Jarvis core 实现，虽然公共 schema 已迁入通用层。
- Jarvis 默认 `agentRuntime.executionMode=skip`，避免与 backend-native tool calling 双重执行；package runtime 已支持 `execute`，但 Jarvis 主路径尚未默认启用 deterministic executor。
- subagent orchestration 仍主要在 `jarvis/src/core`，但已消费统一 `MemoryContract`。
- runtime feedback 已可收集和进入质量门禁，仍需要更多真实线上样本持续补充。

因此当前成熟度判断：

- memory-driven runtime: 90%-92%
- complete intent-driven runtime: 88%-92%

## Target Architecture

长期目标不是把所有 Jarvis 代码都塞进 `memory-runtime`，而是拆出三层边界：

```text
intent-runtime
  IntentFrame / IntentStep / policy / clarification / execution plan / feedback schema

memory-runtime
  MemoryContract / retrieval / injection / memory stores / memory runtime events

jarvis-core adapters
  JarvisIntentResolver / JarvisMemoryStores / JarvisToolRouter integration / channels / scheduler
```

这能避免 `memory-runtime` 名义上是 memory 层，实际继续吸收越来越多 intent 和 execution 逻辑。

## P0: Stabilize The Runtime Boundary

### P0.1 Define package boundaries explicitly

Status: completed in this phase.

目标：

- 明确哪些模块属于 `intent-runtime`，哪些属于 `memory-runtime`，哪些必须留在 `jarvis-core`。
- 在文档和 import 结构上防止通用层继续吸收 Jarvis-specific runtime 逻辑。

交付物：

- 更新 `docs/core/universal-memory-layer.md`，增加 `intent-runtime` 与 `memory-runtime` 边界。
- 新增或调整 barrel exports，保证通用层只暴露稳定 API。
- 增加 dependency check，至少用测试或脚本验证 `memory-runtime` 不 import `core/*`。

优先级原因：

- 边界不先定住，后续迁移会继续把职责混在一起。

### P0.2 Move execution-plan primitives toward intent runtime

Status: completed for the current compatibility phase.

目标：

- 将 `IntentExecutionPlan`、`IntentStepRuntime` 的通用类型和纯逻辑从 `core/intentExecutionPlan.ts` 中拆出。
- 保留 Jarvis-specific tool mapping 在 core adapter 层。

交付物：

- 新增 `jarvis/src/intent-runtime/executionPlan.ts` 或临时放入 `memory-runtime/executionPlan.ts`。
- 抽出纯函数：step ordering、duplicate suppression、runtime state formatting、completion criteria。
- `core/intentExecutionPlan.ts` 只负责 Jarvis tool mapping 和兼容 re-export。

依赖：

- P0.1 边界定义。

### P0.3 Treat tool-backed actions as runtime obligations

Status: completed for the current boundary phase; broader orchestration remains in P1.

目标：

- 将 `push_to_channel`、`task_add` 这类 action 从 prompt convention 提升为 execution contract。
- 用户明确要求工具动作时，runtime 必须验证工具结果，而不是接受 LLM 自述完成。

交付物：

- 扩展 execution plan required tool 类型，不只支持 `task_add` / `recall_memory`。
- 将 `push_to_channel` 纳入 required tool / completion criteria。
- 为 `run_shell_command` 替代真实工具的情况保留 deterministic rewrite，但将其定位为 fallback，不是主机制。

当前实现状态：

- `push_to_channel` 已进入 `IntentStepRuntime` 的 enforceable tool set；
- 单步但需要真实工具的请求也会生成 execution contract，不再只支持多步骤请求；
- auto-push fallback 执行后会回写 step runtime state，避免工具结果与 execution contract 脱节。

优先级原因：

- 这是近期微信推送问题暴露出的核心教训：工具动作必须由 runtime 负责闭环。

## P1: Make Intent Runtime Executable

### P1.1 Build a step orchestrator

Status: completed for known required tools in this phase.

目标：

- 将 multi-intent 从“执行提示 + 部分 required-tool enforcement”升级为可运行 step orchestrator。

交付物：

- `IntentStepRuntime` 支持状态：`pending` / `running` / `succeeded` / `blocked` / `failed` / `skipped`。
- 每个 step 记录 attempts、tool calls、agent calls、observed result、failure reason。
- dependent step 只有在 dependency succeeded 后运行。
- final response 基于 step state 汇总，而不是完全依赖 LLM 自述。

保守实现：

- 第一阶段只托管 known required tools：`task_*`、`push_to_channel`、`recall_memory`。
- `analyze` / 普通 `execute` 仍交给主 LLM，但必须被 step runtime 记录。

当前实现状态：

- `IntentStepRuntime` 已支持 `running` 状态；
- tool-backed step 会记录 attempts、last tool、tool calls 和 observed results；
- dependent step 只有在依赖 step succeeded 后才允许执行；
- 同一工具的多个 step 会按 request args / step target 匹配，避免仅按工具名误归因；
- 当前实际 enforce 范围仍限于 `task_add`、`push_to_channel`、`recall_memory`。

### P1.2 Clarification state machine

Status: completed for runtime state tracking in this phase.

目标：

- 将当前 blocking-only clarification policy 升级为多轮状态机。

交付物：

- 记录已问问题、用户回答、字段映射和 pending requirements。
- 支持 step-level 补参，例如 schedule time、destructive target、channel target。
- 支持默认方案确认和用户改选。
- 避免重复追问同一字段。

依赖：

- P1.1 step runtime state。

当前实现状态：

- 新增 `ClarificationRuntimeState`，记录 pending / answered requirements、已问问题、已回答问题和 answers；
- 新增 clarification answers 合并逻辑，可把用户回答映射回 step-level 或 intent-level requirement；
- clarification policy 可根据 runtime state 过滤已回答的问题，避免重复追问同一字段；
- Jarvis 主流程已保存 clarification runtime state，并在用户补充回答后更新 state；
- 当前仍复用现有 WebSocket ask_user 交互，尚未引入更复杂的多轮 UI。

### P1.3 Unify tool/subagent memory consumption

Status: completed for step-level memory contract propagation in this phase.

目标：

- tool/subagent 层不再各自轻量理解 memory policy，而是消费同一份 `MemoryContract` 和 per-step memory decision。

交付物：

- 为每个 step 派生 memory scope：`session / fact / entry / none`。
- subagent prompt 显式携带 memory decision。
- `recall_memory` fallback 继承 intent time range、memory target 和 rewritten query。
- external-only subagent 请求禁止 personal memory leakage。

当前基础：

- `ToolRouter` 已开始消费 `MemoryContract`。
- 需要继续把 per-step policy 和 subagent request 绑定起来。

当前实现状态：

- 新增 `StepMemoryDecision`，从 `IntentFrame + MemoryContract` 派生每个 step 的 memory scope、query、constraints 和 reasons；
- Jarvis 主流程会把 step-level memory decisions 注入 `ToolRouter`；
- subagent prompt 中现在同时包含整体 `MemoryContract` 和匹配到的 step-level memory decision；
- subagent 检索会按 step constraints 收紧 facts / entries 注入范围；
- external-only contract 仍会阻止 personal memory 注入；
- `recall_memory` 仍继承 router 的 time range、date range、rewritten query 和 current user prompt fallback。

## P2: Evaluation And Feedback Loop

### P2.1 Promote runtime feedback candidates into reviewed eval cases

Status: completed for a local human-review loop in this phase.

目标：

- 将 runtime feedback 从“产生 candidate JSONL”变成“可 review、可晋升、可追踪”的闭环。

交付物：

- 增加 candidate review workflow：accept / reject / merge / annotate root cause。
- 将 accepted candidates 写入 `matrix-cases.jsonl` 或单独 reviewed case file。
- 为每个 promoted case 标注 principle、dimension、invariant、root cause。

当前实现状态：

- 新增 `scripts/review_intent_feedback.ts`，可从 runtime feedback candidate JSONL 生成人工 review template；
- review decision 支持 `accept / reject / merge / pending`，accepted candidate 会晋升到 `evals/intent/reviewed-runtime-cases.jsonl`；
- promoted case 会保留 source、root cause、generatedAt、tags 和人工填写的 model / expect；
- `intent:matrix` 默认读取 reviewed runtime case file，因此晋升后的 case 会进入常规矩阵。

### P2.2 Add execution-contract evals

Status: completed for known tool-backed obligations in this phase.

目标：

- 当前 intent matrix 更偏 classification / policy；下一步需要覆盖 tool-backed execution contract。

交付物：

- 新增 eval dimension：`executionContract`。
- 覆盖：
  - required tool missing should be enforced
  - shell workaround should be rewritten
  - tool result failure should prevent success claim
  - schedule create/delete/update should route to task tools
  - channel push should route to `push_to_channel`

当前实现状态：

- `run_intent_matrix.ts` 新增 `executionContract` dimension，并检查 execution plan mode、required tools、step modes、initial statuses、missing-step prompt、deterministic tool request、dependency gate 和失败工具结果；
- 新增 `evals/intent/execution-contract-cases.jsonl`，覆盖微信推送必须使用 `push_to_channel`、schedule create 必须生成 `task_add`、dependent step 必须等待依赖、工具失败不能宣称成功；
- execution-contract eval 与现有 clarification / memory policy eval 共用同一 runner。

### P2.3 Model stability and calibration gates

Status: completed for deterministic matrix reporting hooks in this phase.

目标：

- 将模型差异、JSON repair rate、fallback rate、confidence calibration 变成 runtime 选择依据。

交付物：

- intent matrix 支持跨模型报告。
- repeated eval 进入 nightly trend。
- confidence floor 可按 model / dimension / risk level 配置。
- 高风险 action 使用更高 confidence floor。

当前实现状态：

- `run_intent_matrix.ts` 支持 `--repeat <n>`，report / JSON 中新增 repeat 维度统计；
- runner 支持 `--confidence-floor <0..1>` 以及 per-case `expect.calibration`；
- report / JSON 中新增 model source 维度统计，为后续跨模型 nightly trend 留出稳定字段。

## P3: Package Readiness

### P3.1 Public API hardening

Status: completed for package-like local consumption in this phase.

目标：

- 让通用 runtime 可以被 Jarvis 之外的项目嵌入。

交付物：

- 稳定 exports。
- API examples：minimal runtime、custom stores、custom intent model、custom observer。
- 明确 semver policy。

当前实现状态：

- 新增 `packages/memory-runtime/package.json` 与 `packages/intent-runtime/package.json`，提供 package entrypoint 和子路径 exports；
- 新增两个 package README，说明职责边界、最小用法和兼容 shim；
- 新增 package-level API smoke tests，防止公共 exports 在后续重构中断裂；
- 当前 package 仍标记为 `private: true`，先保证本仓库内可消费，再考虑独立发布和 semver。

### P3.2 Move runtime to package-like structure

Status: completed with compatibility shims in this phase.

目标：

- 为未来独立发布做结构准备。

候选结构：

```text
packages/
  intent-runtime/
  memory-runtime/
jarvis/src/core/
  adapters/
```

当前实现状态：

- 已采用候选结构，将 runtime 实现迁入 `packages/memory-runtime/src` 与 `packages/intent-runtime/src`；
- `jarvis/src/memory-runtime/*` 与 `jarvis/src/intent-runtime/*` 保留为 thin re-export shim；
- root workspace 已加入 `packages/*`；
- `runtime:check-boundaries` 现在检查 package 源目录，不再只检查 Jarvis shim 目录。

### P3.3 Runtime quality dashboard

Status: completed for static eval/report hooks; live dashboard remains future work.

目标：

- 让 intent runtime 的健康状态可观测。

指标：

- subject / taskType / memoryTarget distribution
- policy correction rate
- JSON repair rate
- clarification block rate
- execution contract enforcement rate
- tool failure rate
- memory injection empty / rejected rate
- runtime feedback candidate volume

当前实现状态：

- `intent:matrix` JSON / Markdown report 已包含 dimension、invariant、axis、model source、repeat 维度统计；
- runtime feedback candidate 可通过 review workflow 晋升为 reviewed eval case；
- 尚未实现独立 UI dashboard，当前阶段以 eval report + JSON artifact 作为 dashboard 数据源。

## P4: Resolver Adapter And Intent Runtime API

Status: completed for the Jarvis integration path in this phase.

目标：

- 将 `IntentResolver` 从 Jarvis core 的具体实现，抽成 `intent-runtime` 可消费的标准 adapter。
- 让 `intent-runtime` 拥有完整的 `understand -> policy -> clarify -> planExecution` 入口，而不仅是 execution plan primitives。

交付物：

- 在 `packages/intent-runtime/src` 定义 `IntentRuntime`、`IntentResolverAdapter`、`IntentRuntimeConfig`、`IntentRuntimeEvent`。
- 将 model-client、JSON repair、deterministic fallback、policy trace、confidence calibration 的接口沉淀为通用 contract。
- 新增 `JarvisIntentResolverAdapter` 留在 `jarvis/src/core/adapters` 或 `jarvis/src/core`，包装现有 `IntentResolver`。
- `agent.ts` 不再直接依赖 `IntentResolver` 细节，而是依赖 `IntentRuntime` 或 adapter interface。
- 增加 package-level eval / smoke test，验证外部项目可用自定义 resolver adapter 跑完整 intent lifecycle。

完成后成熟度预期：

- complete intent-driven runtime: 65%-70%

验收标准：

- `packages/intent-runtime/src` 不 import `jarvis/src/core/*`。
- `JarvisIntentResolverAdapter` 是唯一接触现有 Jarvis resolver 的桥。
- intent matrix 可选择通过 `IntentRuntime` 入口运行，而不是直接调用 Jarvis resolver。

当前实现状态：

- 新增 `packages/intent-runtime/src/runtime.ts`，定义 `IntentRuntime`、`DefaultIntentRuntime`、`IntentResolverAdapter`、`IntentClarificationAdapter`、`IntentExecutionPlanner`、runtime events 和 diagnostics；
- `DefaultIntentRuntime.understand()` 已串联 `resolve intent -> evaluate policy -> evaluate confidence -> resolve clarification -> plan execution`，返回统一的 `IntentRuntimeResult`；
- 已新增 `IntentPolicyAdapter` / `IntentPolicyEvaluation`，把 query subject 与 policy trace 作为 runtime lifecycle 的一等结果和 `policy_evaluated` 事件；
- 已沉淀 resolver 周边通用 contract：`IntentModelJsonClient`、`IntentJsonRepairAdapter`、`IntentFallbackAdapter`，供 Jarvis 或外部 host 组合 model JSON、repair 和 fallback 流程；
- 已新增 `IntentConfidenceGate` / `evaluateIntentConfidence()`，runtime 会输出 `confidence_evaluated` 事件，并把 confidence evaluation 写入 diagnostics；critical gate 可配置为直接 fail fast；
- 新增 `StaticIntentResolverAdapter`，用于 package tests 和外部项目快速嵌入；
- 新增 `jarvis/src/core/jarvisIntentResolverAdapter.ts`，作为 Jarvis core `IntentResolver` 的唯一 runtime adapter；
- `LocalModelRouter` 已改为通过 `DefaultIntentRuntime + JarvisIntentResolverAdapter` 解析 intent；
- `intent:matrix` runner 已改为通过 `DefaultIntentRuntime` 入口运行，不再直接 new `IntentResolver`；
- package-level API smoke test 覆盖完整 intent runtime lifecycle 与 confidence gate 行为。

## P5: Runtime Executor And Orchestrator

Status: completed for the package runtime and Jarvis adapter boundary in this
phase.

目标：

- 将当前分散在 `agent.ts` / `ToolRouter` / prompt retry 中的执行闭环，升级成 intent-runtime 的可执行 orchestrator。
- runtime 不只告诉 LLM “应该调用工具”，还要跟踪、调度、验证和阻断工具动作。

交付物：

- 在 `packages/intent-runtime/src` 新增 `IntentExecutor`、`ToolExecutorAdapter`、`AgentExecutorAdapter`、`ExecutionObserver`。
- `IntentStepRuntime` 从 state tracker 升级为 orchestrator state backend，支持：
  - step queue；
  - dependency scheduling；
  - retry policy；
  - blocked / failed / succeeded finalization；
  - final response completion contract。
- 将 known required tools 从硬编码集合提升为 registry-driven capability contract：
  - `task_add` / `task_update` / `task_delete` / `task_list`
  - `push_to_channel`
  - `recall_memory`
  - workspace file operations
  - shell command operations
  - subagent delegation
- Jarvis `ToolRouter` 变成 `ToolExecutorAdapter`，而不是事实上的 orchestrator。
- final answer 必须消费 execution state；工具失败时禁止“已完成”式成功声明。

完成后成熟度预期：

- complete intent-driven runtime: 75%-80%

验收标准：

- 微信推送、任务创建、文件写入、shell workaround、subagent delegation 都有 execution-contract eval。
- 所有 tool-backed requests 都至少经历一次 runtime tool-result validation。
- `agent.ts` 中 multi-intent retry / missing-step prompt 逻辑明显收敛到 `IntentExecutor`。

当前实现状态：

- 新增 `packages/intent-runtime/src/executor.ts`，定义 `IntentExecutor`、`ToolExecutorAdapter`、`AgentExecutorAdapter`、`ExecutionObserver`、`RuntimeCapabilityRegistry`；
- `IntentExecutor.execute()` 已支持 step queue、dependency scheduling、retry/blocking、tool result validation、agent result validation、execution events、final-response contract；
- 默认 capability registry 已覆盖 `task_*`、`push_to_channel`、`recall_memory`、workspace file tools、shell command、subagent delegation；
- Jarvis `ToolRouter` 已实现 `ToolExecutorAdapter.executeTools()`，从 runtime 视角成为工具执行 adapter，而不再只是 core 内部路由器；
- package-level executor tests 覆盖 deterministic task execution、push failure final-response guard、dependency blocking；
- 当前 `agent.ts` 尚未整体迁移到 `IntentExecutor` 主循环；下一阶段 P6 会把主响应路径切到统一 `AgentRuntime` facade。

## P6: Unified Agent Runtime

Status: completed for package-level runtime, Jarvis main-path integration,
backend-neutral LLM/tool loop extraction, and Jarvis unified runtime adapter.

目标：

- 把 intent runtime 和 memory runtime 串成一个真正的 `AgentRuntime` lifecycle。
- `agent.ts` 退化为 Jarvis application adapter，不再是 runtime 规则集中地。

目标生命周期：

```text
AgentRuntime.handleTurn
  -> intentRuntime.understand
  -> clarificationPolicy.resolve
  -> memoryRuntime.plan/retrieve/inject
  -> skillRuntime.retrieve
  -> intentRuntime.planExecution
  -> intentExecutor.execute
  -> responseComposer.compose
  -> llmBackend/toolLoop.run
  -> observers.record
```

交付物：

- 新增 `packages/intent-runtime` 或新包 `packages/agent-runtime` 中的 `AgentRuntime` facade。
- 新增 backend-neutral `LlmBackend` / `PromptCompiler` / `ToolLoopRuntime`，避免主响应路径继续绑定 Gemini CLI protocol。
- 将 skill retrieval 纳入统一 runtime context，避免 `agent.ts` 单独注入。
- 将 memory decision、step memory decision、tool/subagent memory constraints 作为同一份 `RuntimeContext` 传递。
- 引入 `ResponseComposer`，让最终回答基于 intent、memory、execution state、tool observations 统一生成。
- Jarvis 主流程用 feature flag 切到 `AgentRuntime`，保留回滚开关。

完成后成熟度预期：

- complete intent-driven runtime: 85%-90%

当前成熟度：

- complete intent-driven runtime: 88%-92%
- 判断依据：P6 验收标准已闭环；Jarvis 主响应路径已通过 `AgentRuntime.handleTurn()` 统一执行 intent、memory、skill、response compose 和 LLM/tool loop；`agent.ts` 当前主要承担 application adapter、事件转发、clarification UI、topic shift、历史压缩和持久化副作用。
- 本轮推进后，`agent.ts` 不再承载 memory retrieval / injection / skill retrieval / response composition / AgentRuntime construction 的详细规则；这些规则已收敛到 `jarvis/src/core/jarvisUnifiedRuntime.ts`，`agent.ts#runUnifiedRuntimeTurn()` 只负责 strip old history、调用 unified runtime、应用 system instruction。
- 尚未稳定进入 92%+ 的原因：`IntentResolver` 仍未完全抽离为通用 runtime adapter，Jarvis 默认未启用 `agentRuntime.executionMode=execute`，subagent orchestration 仍在 Jarvis core，真实线上样本反馈还需要继续积累。

验收标准：

- 主响应路径不再由 `agent.ts` 手动拼接 intent / memory / tools / retry 规则。
- external-only、current-context、conversation-history、tool-backed action 在 main response、tool、subagent 三层共享同一 runtime context。
- 现有 intent matrix、execution-contract eval、ToolRouter tests 全部通过。

当前实现状态：

- 新增 `packages/agent-runtime/src/runtime.ts`，定义 `AgentRuntime`、`RuntimeContext`、`SkillRuntime`、`ResponseComposer`、`AgentRuntimeEvent`；
- 新增 `packages/agent-runtime/src/llmBackend.ts`，定义 `LlmBackend`、`LlmEvent`、`LlmBackendCapabilities`、`LlmMessage`、`PromptCompiler`、`ToolLoopRuntime` 和 `ToolLoopPlanner`；
- 新增 `packages/agent-runtime/src/openAiBackend.ts`，实现 OpenAI-compatible Chat Completions streaming backend 和 `OpenAiPromptCompiler`；
- `AgentRuntime.handleTurn()` 已串联 `intentRuntime.understand -> memoryRuntime.plan/retrieve/inject -> skillRuntime.retrieve -> intentExecutor.execute/skip -> responseComposer.compose`；
- `AgentRuntime.handleTurn()` 可选接收 `llmLoop`，从同一 facade 内编排 backend-driven tool loop；
- `ToolLoopRuntime` 已接管原 `agent.ts` 中的主 Gemini stream/tool loop 语义，包括 streaming、native tool calls、tool result resume、retry、max tool iteration guard、consecutive tool failure guard、deterministic multi-intent enforcement、missing-step prompt 和 post-content tool completion；
- `RuntimeContext` 统一承载 `IntentRuntimeResult`、`MemoryContract`、`StepMemoryDecision[]`、memory retrieval/injection、skills、execution result 和 composed response；
- 默认 `ResponseComposer` 会把 memory decision、step-level memory decisions、runtime skills、memory injection 和 execution final-response contract 组成统一 system context；
- `packages/agent-runtime` 不 import `jarvis/src/core/*`，并已纳入 `runtime:check-boundaries`；
- 新增 `jarvis/src/core/geminiBackendAdapter.ts`，把 Gemini CLI `sendMessageStream()`、`GeminiEventType`、`Part[]`、`functionResponse` 翻译为 runtime-owned backend protocol；
- 新增 `jarvis/src/core/llmBackendFactory.ts`，按 `llmBackend.provider` 选择 `gemini` 或 `openai`，并把 Gemini CLI tool declarations 转换为 runtime `LlmToolSchema[]`；
- Jarvis 增加 `llmBackend` 配置：
  - `provider` 默认 `gemini`；
  - `openai.apiKeyEnv` 默认 `OPENAI_API_KEY`；
  - `openai.model` 默认 `gpt-4.1`；
  - `openai.baseUrl` 默认 `https://api.openai.com/v1`；
- Jarvis 增加 `agentRuntime` 配置：
  - `enabled` 默认 `true`；
  - `executionMode` 默认 `skip`，当前主内容生成仍使用 Gemini compatibility backend，但 loop orchestration 已迁入 runtime；
  - `observability` 可开启 runtime 事件日志；
- 新增 `jarvis/src/core/jarvisRuntimeAdapter.ts`，集中封装 Jarvis application adapter：
  - `ToolRouter` -> runtime `ToolExecutorAdapter`；
  - `IntentStepRuntime` -> runtime `ToolLoopPlanner`；
  - retry、tool-loop guard、post-content push、deterministic multi-intent enforcement 的 Jarvis 配置装配；
- 新增 `jarvis/src/core/jarvisUnifiedRuntime.ts`，集中封装 Jarvis 主 turn runtime assembly：
  - fallback runtime intent；
  - `DefaultMemoryRuntime` / `DefaultMemoryRetriever`；
  - Jarvis query rewrite、recent conversation recall、summary fallback；
  - `SkillRuntime` retrieval；
  - step memory planning；
  - response composer system context；
  - `AgentRuntime.handleTurn()` 调用；
- `agent.ts#runUnifiedRuntimeTurn()` 已通过一次 `AgentRuntime.handleTurn()` 完成 memory contract、step memory decisions、skill retrieval、runtime response context 和 backend LLM/tool loop；
- `agent.ts` 的主响应阶段不再直接 new `ToolLoopRuntime`，也不再内联构造 `DefaultMemoryRuntime` / `DefaultMemoryRetriever` / `AgentRuntime`，只负责构造本 turn 的输入、图片消息、Jarvis config、ToolRouter、事件转发和持久化副作用；
- 无 resolved intent 或关闭 `agentRuntime.enabled` 时保留旧路径，作为回滚开关；
- Jarvis runtime adapter tests 覆盖 ToolRouter bridge、deterministic multi-intent planner、ToolLoopRuntimeOptions 装配；
- Jarvis unified runtime tests 覆盖 external memory contract 共享和从 unified runtime entry 执行 backend LLM loop；
- package-level tests 覆盖完整 intent-memory-skill-execution-response lifecycle、external memory boundary 传递、execution incomplete 时禁止成功声明；
- backend-level tests 覆盖 neutral LLM loop、Gemini compatibility adapter、OpenAI-compatible streaming tool call、tool result round-trip、backend factory、retry exhaustion hook；
- `npm run llm:backend:eval` 提供 offline backend-aware smoke eval；
- 现有 `ToolRouter` / `IntentExecutor` / `IntentPlan` 相关回归已通过。

最终边界说明：

- Gemini CLI 仍是默认 main-chat backend，但 OpenAI-compatible backend 已可通过配置切换；
- `agentRuntime.executionMode=execute` 已由 package runtime 支持，Jarvis 默认仍使用 `skip`，避免在同一 turn 中同时由 `IntentExecutor` 和 backend-native tool calling 双重执行工具；
- Ollama/local planner-only backend 按当前阶段决策暂不实现；如需 Anthropic，可继续实现新的 `LlmBackend` 和 `PromptCompiler`，复用同一个 `ToolLoopRuntime`。

## P7: Quality Gates And Runtime Dashboard

Status: completed for local/CI quality gate, trend JSON, backend-aware eval
aggregation, dashboard output, and feedback-loop metrics.

目标：

- 从“有 eval report”升级为“runtime 质量门禁”。
- 每次 runtime 改动都能看到 intent、memory、execution 的质量变化。

交付物：

- 增强 `intent:matrix`，输出稳定 trend JSON：
  - subject / taskType / memoryTarget distribution；
  - policy correction rate；
  - JSON repair / fallback rate；
  - clarification block rate；
  - execution contract enforcement rate；
  - tool failure / retry / blocked rate；
  - memory injection empty / rejected rate；
  - runtime feedback candidate volume。
- 新增 `scripts/runtime_quality_dashboard.ts`，从 eval logs 聚合 Markdown/JSON dashboard。
- 增加 quality gates：
  - required invariant pass rate 必须 100%；
  - high-risk action confidence floor；
  - external personal-memory leakage 必须 0；
  - tool-backed success-without-tool 必须 0。
- 将 reviewed runtime feedback 自动纳入 nightly / local full eval。

当前实现状态：

- `scripts/run_intent_matrix.ts` 已在 `intent-matrix-latest.json` 中输出 `trend`，并额外写出 `intent-matrix-trend-latest.json`：
  - subject / taskType / memoryTarget / riskLevel / clarificationState distribution；
  - policy correction rate 和 reason code distribution；
  - JSON repair / fallback rate；
  - clarification block rate；
  - execution contract enforcement rate；
  - tool failure / retry / blocked rate；
  - memory empty / rejected rate；
  - runtime feedback candidate volume。
- `scripts/run_llm_backend_evals.ts` 已输出 `llm-backend-*.json/md` 和 `llm-backend-latest.json/md`，供 dashboard 机器读取。
- 新增 `scripts/runtime_quality_dashboard.ts`：
  - 聚合 intent matrix、LLM backend eval、runtime feedback candidate/review/promote 数据；
  - 输出 `runtime-quality-*.json/md` 和 `runtime-quality-latest.json/md`；
  - `--gate` 模式下 gate 失败会返回非 0 exit code。
- 新增 package scripts：
  - `npm run runtime:dashboard`：只生成 dashboard；
  - `npm run runtime:quality`：一键执行 `intent:matrix`、`llm:backend:eval`、`runtime:check-boundaries` 和 dashboard gate。
- 当前 quality gates：
  - `required_invariant_pass_rate`：matrix required invariant pass rate 必须 100%；
  - `high_risk_action_confidence_floor`：high-risk action confidence 不低于默认 0.8；
  - `external_personal_memory_leakage_zero`：external-only request 不允许 personal facts/session/entries；
  - `tool_backed_success_without_tool_zero`：tool-backed 成功路径必须存在 required tool contract；
  - `llm_backend_eval_pass`：backend adapter smoke eval 必须 100% 通过。
- reviewed runtime feedback 已纳入 local full eval：`run_intent_matrix.ts` 默认 case paths 包含 `evals/intent/reviewed-runtime-cases.jsonl`。
- `scripts/review_intent_feedback.ts` 保持 capture -> review template -> promote regression 的路径；dashboard 会统计 captured candidates、review template rows、promoted regressions 和 closure rate。

当前验证结果：

- `npm run runtime:quality`：通过，生成 `evals/logs/runtime-quality-latest.md/json`；
- matrix：27/27；
- LLM backend eval：2/2；
- runtime boundary check：通过。

完成后成熟度预期：

- complete intent-driven runtime: 90%-95%

验收标准：

- CI 或本地标准命令可以一键运行 runtime quality gate。
- dashboard 能直接回答“这次改动有没有让 intent-driven runtime 变差”。
- runtime feedback candidate 有从 capture 到 review 到 promoted regression 的闭环指标。

## P8: External Package Readiness And Semver

目标：

- 让 runtime 不只是仓库内部 package-like，而是达到可被外部 agent 项目嵌入的发布标准。

交付物：

- 每个 package 增加 build 输出：
  - `dist/index.js`
  - `dist/index.d.ts`
  - source map 可选。
- package exports 从 `src/*.ts` 切到 `dist/*.js`。
- 明确 `public` / `internal` API：
  - public API 有 README、examples、API smoke tests；
  - internal API 不进入 package exports。
- 增加 examples：
  - minimal memory runtime；
  - custom intent model；
  - custom vector store；
  - custom tool executor；
  - embedding in a non-Jarvis agent。
- 制定 semver policy：
  - schema breaking changes；
  - policy behavior changes；
  - adapter API changes；
  - eval invariant changes。
- 将 package `private: true` 改为可发布前的 explicit decision；不一定立即 publish，但发布路径必须清晰。

完成后成熟度预期：

- complete intent-driven runtime: 95%-100%

验收标准：

- 外部 demo 不 import `jarvis/src/*`。
- `npm pack --dry-run` 能看到合理产物。
- package API tests 和 examples 在 clean install 下可运行。

## Execution Plan To 100%

优先级顺序：

1. P4.1 定义 `IntentRuntime` / `IntentResolverAdapter` API。
2. P4.2 增加 `JarvisIntentResolverAdapter`，让 Jarvis 通过 adapter 使用现有 resolver。
3. P4.3 改造 intent matrix，使其可通过 `IntentRuntime` 入口运行。
4. P5.1 定义 `IntentExecutor` / `ToolExecutorAdapter` / `AgentExecutorAdapter`。
5. P5.2 将 `push_to_channel`、`task_*`、`recall_memory` 从 known hardcode 转成 capability registry。
6. P5.3 将 workspace file、shell、subagent delegation 纳入 execution contract。
7. P5.4 把 `agent.ts` 中 missing-step retry 和 tool-result validation 迁入 executor。
8. P6.1 定义 `RuntimeContext`，统一 intent、memory、skill、execution state。
9. P6.2 建立 `AgentRuntime.handleTurn` facade，并用 feature flag 接入 Jarvis。
10. P6.3 将 skill retrieval 和 subagent memory consumption 迁入统一 runtime context。
11. P7.1 实现 runtime quality dashboard 和 quality gates。
12. P7.2 将 reviewed feedback cases 纳入标准 full eval。
13. P8.1 增加 build / d.ts / package exports 到 `dist`。
14. P8.2 增加 external examples 和 semver policy。
15. P8.3 清理 Jarvis compatibility shims 或明确长期兼容策略。

推荐批次：

- Batch 1：P4.1-P4.3。收益最大、风险较低，先把 resolver 入口标准化。
- Batch 2：P5.1-P5.4。收益大、风险最高，需要密集 eval 覆盖，尤其是 tool result 和 final response。
- Batch 3：P6.1-P6.3。把 Jarvis 主路径切到统一 runtime，建议 feature flag 灰度。
- Batch 4：P7.1-P7.2。把质量评估从手工报告变成门禁。
- Batch 5：P8.1-P8.3。发布工程化和外部可用性。

## 100% Definition Of Done

达到“完整 intent-driven runtime”的标准：

- `IntentRuntime` 是理解、policy、clarification、execution planning 的标准入口。
- `AgentRuntime` 是 Jarvis 主响应路径的标准入口，`agent.ts` 只做应用层 adapter。
- 所有 tool-backed action 都由 runtime executor 调度和验证，不能靠 LLM 自述完成。
- tool、subagent、main response 共享同一份 `RuntimeContext`、`MemoryContract` 和 step-level memory decision。
- `IntentResolver`、ToolRouter、MemoryService、channels、scheduler 都通过 adapter 接入，不被 package runtime 直接依赖。
- package runtime 没有 `jarvis/src/core/*` 反向 import，并由 boundary check 固化。
- eval 覆盖 classification、memory policy、clarification、execution contract、tool failure、subagent delegation、runtime feedback promotion。
- high-risk / tool-backed invariant 通过率必须 100%，external personal-memory leakage 必须 0。
- runtime quality dashboard 能持续追踪 regression。
- package public API、examples、build artifacts、semver policy 达到外部项目可嵌入标准。
