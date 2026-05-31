# Intent-Driven Runtime Roadmap

本文档记录 Jarvis 将当前 intent / memory / clarification / execution 能力抽成独立 runtime 层的下一步工作拆解。

## Current State

当前实现已经具备一套可运行的通用层雏形：

- `jarvis/src/memory-runtime` 已承载 `IntentFrame`、`MemoryContract`、`ClarificationQuestion`、memory policy、clarification policy、retrieval adapter、injection planner 和 `DefaultMemoryRuntime`。
- `memory-runtime` 基本没有反向依赖 `jarvis/src/core/*`，具备继续独立化的基础。
- `agent.ts#refreshContext()` 已通过 `DefaultMemoryRuntime` 执行主响应路径的 `understand -> planMemory -> retrieve -> inject -> observe`。
- `DefaultMemoryRetriever` 已支持 `session / fact / entry` 三层 store adapter，并通过 extension points 保留 Jarvis 的 query rewrite、recent conversation recall、summary fallback。
- intent eval 已从单点回归 case 演进为 principle / invariant / semantic axis 矩阵。

当前缺口也很明确：

- `DefaultMemoryRuntime` 只接管主响应的 memory lifecycle，还不是完整 intent-driven agent runtime。
- `IntentExecutionPlan`、multi-intent step runtime、tool execution 和 subagent orchestration 仍在 `jarvis/src/core`。
- `IntentResolver` 仍是 Jarvis core 实现，虽然公共 schema 已迁入通用层。
- skill retrieval、tool/subagent memory consumption、runtime feedback 晋升 eval case 还没有完全纳入统一 runtime。

因此当前成熟度判断：

- memory-driven runtime: 65%-70%
- complete intent-driven runtime: 40%-50%

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

目标：

- 让通用 runtime 可以被 Jarvis 之外的项目嵌入。

交付物：

- 稳定 exports。
- API examples：minimal runtime、custom stores、custom intent model、custom observer。
- 明确 semver policy。

### P3.2 Move runtime to package-like structure

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

短期可先不移动目录，只通过 import boundary 和 docs 约束。

### P3.3 Runtime quality dashboard

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

## Suggested Order

1. P0.1 Define package boundaries explicitly
2. P0.3 Treat tool-backed actions as runtime obligations
3. P0.2 Move execution-plan primitives toward intent runtime
4. P1.1 Build a step orchestrator for known required tools
5. P1.2 Clarification state machine
6. P1.3 Unify tool/subagent memory consumption
7. P2.2 Add execution-contract evals
8. P2.1 Promote runtime feedback candidates into reviewed eval cases
9. P2.3 Model stability and calibration gates
10. P3 package readiness work

## Near-Term Definition Of Done

短期不要求 Jarvis 立即变成完整独立 package。下一阶段完成标准是：

- 通用层边界清晰，`memory-runtime` 不再继续吸收 execution 逻辑；
- tool-backed user requests 由 execution contract 闭环，不能靠 LLM 自述完成；
- `IntentExecutionPlan` 的纯逻辑进入可复用 runtime 边界；
- 至少 `task_*`、`push_to_channel`、`recall_memory` 进入 step runtime enforcement；
- execution-contract eval 能覆盖最近真实失败模式；
- runtime feedback candidate 有人工 review 和晋升路径。
