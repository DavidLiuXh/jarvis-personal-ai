# Autonomous Task Runtime Roadmap

本文档定义 Jarvis 从当前 Multi-intent / IntentSteps 能力，演进到“自动评估任务、拆分子任务、执行、验收”的下一阶段工程计划。

## 1. 背景与边界

当前 `intent-driven-runtime` 已完成其既定目标：Jarvis 主响应路径已经进入统一 runtime，intent、memory、skill、tool loop 和 response compose 已被纳入统一生命周期。

但这不等于 Jarvis 已经具备完整 autonomous task execution 能力。当前 Multi-intent 更准确地说处在：

```text
多意图识别
  -> IntentSteps 推导
  -> 部分 known required tools 的 deterministic enforcement
  -> 工具结果观测
  -> 防止未完成时声称成功
```

目标能力是：

```text
任务评估
  -> 目标驱动拆解
  -> TaskGraph 编排
  -> runtime 执行
  -> step-level 验收
  -> final acceptance
  -> 失败恢复 / replanning
  -> 持久化审计
```

本 roadmap 不替代 `intent-driven-runtime-roadmap.md`，而是它之后的下一层：`AutonomousTaskRuntime`。

## 2. 目标定义

Jarvis 在面对复杂任务时，需要能显式回答并执行以下问题：

1. 用户真正要达成什么目标？
2. 这个目标需要哪些子任务？
3. 每个子任务需要什么输入、工具、记忆、外部信息和产物？
4. 每个子任务怎样才算完成？
5. 如果某步失败或结果不合格，应该重试、换路径、询问用户，还是中止？
6. 最终回答能否被 runtime 证明为完成，而不是 LLM 自述完成？

## 3. 总体架构

目标架构：

```text
AgentRuntime.handleTurn
  -> IntentRuntime.understand
  -> TaskEvaluator.evaluate
  -> TaskPlanner.plan(TaskSpec -> TaskGraph)
  -> ClarificationRuntime.resolveGraphRequirements
  -> TaskGraphExecutor.execute
  -> AcceptanceRuntime.validateSteps
  -> Replanner.recoverIfNeeded
  -> AcceptanceRuntime.validateFinal
  -> ResponseComposer.composeWithAcceptance
  -> RuntimeFeedback.record
```

核心新增对象：

- `TaskSpec`
- `AcceptanceCriteria`
- `TaskGraph`
- `TaskNode`
- `TaskArtifact`
- `TaskExecutionState`
- `TaskValidationResult`
- `ReplanDecision`

## 4. P0: Task Evaluation Layer

### P0.1 Define `TaskSpec`

目标：

- 在 `IntentFrame` 之上新增任务规格层。
- 不再只表达 `taskType`，而是表达“目标、约束、产物、风险和验收标准”。

建议 schema：

```ts
type TaskSpec = {
  id: string;
  userGoal: string;
  taskKind:
    | "answer"
    | "research"
    | "write_artifact"
    | "modify_workspace"
    | "schedule"
    | "memory_recall"
    | "delegate"
    | "mixed";
  constraints: TaskConstraint[];
  requiredInputs: TaskRequirement[];
  expectedArtifacts: TaskArtifactSpec[];
  acceptanceCriteria: AcceptanceCriteria[];
  riskLevel: "low" | "medium" | "high";
  requiresClarification: boolean;
  sourceIntentId: string;
};
```

验收门控：

- 对单意图请求，必须能生成一个 `TaskSpec`。
- 对 multi-intent 请求，必须能生成一个 root `TaskSpec` 和多个 child specs。
- `TaskSpec` 必须包含至少一个可执行或可回答的 acceptance criterion。
- `TaskSpec` 不允许只复制用户原文；必须结构化表达 goal / kind / constraints / artifacts。
- 新增 eval dimension：`taskEvaluation`。
- 至少覆盖以下 case：
  - 纯问答；
  - 回忆历史；
  - 写入本地 markdown；
  - 抓取网页并整理报告；
  - 添加定时任务；
  - 分析后保存文件再推送。

### P0.2 Define `AcceptanceCriteria`

目标：

- 把“做完”的定义从 prompt convention 变成 runtime contract。

建议 schema：

```ts
type AcceptanceCriteria = {
  id: string;
  scope: "task" | "step" | "artifact" | "final_response";
  type:
    | "tool_result"
    | "file_exists"
    | "file_contains"
    | "response_contains"
    | "source_count"
    | "memory_retrieved"
    | "task_scheduled"
    | "user_confirmed"
    | "custom";
  description: string;
  required: boolean;
  validator: string;
  params: Record<string, unknown>;
};
```

验收门控：

- 每个 tool-backed task 必须至少有一个 `tool_result` criterion。
- 每个 file/artifact task 必须至少有 `file_exists` criterion。
- 每个 research/report task 必须至少有 `source_count` 或 `response_contains` criterion。
- 每个 destructive/high-risk task 必须有 `user_confirmed` criterion。
- 如果 criterion 缺失，runtime 必须生成 `blocked_missing_acceptance_criteria`，不能继续执行。

## 5. P1: TaskGraph Planner

### P1.1 Upgrade `IntentSteps` To `TaskGraph`

目标：

- `IntentSteps` 继续保留为轻量 intent representation。
- 新增 `TaskGraph` 作为执行层一等结构。

建议 schema：

```ts
type TaskGraph = {
  id: string;
  rootTaskId: string;
  nodes: TaskNode[];
  edges: TaskEdge[];
  globalConstraints: TaskConstraint[];
  acceptanceCriteria: AcceptanceCriteria[];
  status: "planned" | "running" | "blocked" | "failed" | "succeeded";
};

type TaskNode = {
  id: string;
  title: string;
  kind:
    | "recall"
    | "research"
    | "analyze"
    | "write_file"
    | "read_file"
    | "run_shell"
    | "schedule"
    | "push"
    | "delegate"
    | "respond";
  requiredCapabilities: string[];
  inputs: TaskInputRef[];
  outputs: TaskOutputSpec[];
  acceptanceCriteria: AcceptanceCriteria[];
  retryPolicy: RetryPolicy;
  timeoutMs?: number;
};
```

验收门控：

- 对包含多个动作的请求，必须生成 `TaskGraph.nodes.length >= 2`。
- 依赖关系必须显式表达，不能只靠自然语言顺序。
- 需要文件产物的任务，必须包含 `write_file` 节点和 artifact output。
- 需要定时任务的请求，必须包含 `schedule` 节点和 `task_scheduled` criterion。
- `TaskGraph` 必须通过 acyclic check。
- 无 capability 的节点必须标记 `blocked_missing_capability`。

### P1.2 Planner Inputs Must Include Runtime Context

目标：

- planner 不只看用户请求，还要看：
  - intent；
  - memory contract；
  - available tools；
  - available skills；
  - backend capabilities；
  - workspace policy；
  - user/channel context。

验收门控：

- 禁用某个工具时，planner 不得生成依赖该工具的 executable node。
- external-only memory contract 下，planner 不得生成 personal memory retrieval node。
- 当前 channel 不支持 push 时，planner 必须生成 clarification 或 blocked state。
- shell network fetch 被禁用时，planner 必须改用允许的 web/search capability 或阻塞。

## 6. P2: TaskGraph Executor

### P2.1 Runtime-Owned Execution

目标：

- 从 “LLM tool loop 自己决定做什么” 升级为 “runtime 按 TaskGraph 调度”。

执行策略：

- `TaskGraphExecutor` 根据 DAG 找到 ready nodes。
- 每个 node 由对应 executor 执行：
  - `ToolNodeExecutor`
  - `LlmNodeExecutor`
  - `SkillNodeExecutor`
  - `SubagentNodeExecutor`
  - `HumanInputNodeExecutor`
- 执行结果写入 `TaskExecutionState`。

验收门控：

- ready node 必须按 dependency 执行，不能跳过上游依赖。
- failed required node 必须阻止下游 required node。
- optional node 失败可以继续，但必须进入 final response evidence。
- runtime 必须记录每个 node 的 start/end/status/tool calls/artifacts/error。
- LLM 不允许声称未执行 node 已完成。

### P2.2 Capability Registry

目标：

- 用 capability 抽象替代硬编码 tool name。

建议 capability：

- `memory.recall`
- `file.read`
- `file.write`
- `shell.run`
- `web.fetch`
- `web.search`
- `task.schedule`
- `channel.push`
- `skill.activate`
- `subagent.delegate`

验收门控：

- 每个 executable node 必须绑定一个 capability。
- capability 缺失时必须阻塞，不允许 fallback 到 LLM 自述。
- capability registry 必须可观测：日志中打印 node -> capability -> executor。
- eval 必须覆盖 capability disabled / missing / permission denied。

## 7. P3: Acceptance Runtime

### P3.1 Step-Level Validators

目标：

- 每个 node 执行后都要被 validator 验收。

基础 validators：

- `toolResultSuccessValidator`
- `fileExistsValidator`
- `fileContainsValidator`
- `artifactRegisteredValidator`
- `taskScheduledValidator`
- `memoryRecallNonEmptyValidator`
- `sourceCoverageValidator`
- `responseStructureValidator`

验收门控：

- validator failed 时，node 不得标记 `succeeded`。
- required validator failed 时，TaskGraph 不得标记 `succeeded`。
- validator result 必须进入 runtime trace。
- final response 必须能引用验收结果。

### P3.2 Final Acceptance

目标：

- 最终回答前验证 root task 是否真的满足目标。

验收门控：

- 所有 required nodes succeeded。
- 所有 required acceptance criteria passed。
- 所有 expected artifacts 已注册。
- 如果有 blocked/failed required node，final response 必须说明阻塞原因，不能声称完成。
- 如果用户要求保存文件，final response 必须包含真实路径。
- 如果用户要求推送，final response 必须包含 push result 或失败原因。

## 8. P4: Durable Task State

### P4.1 Persist `TaskGraphExecution`

目标：

- 支持跨 turn、后台任务、崩溃恢复和人工介入。

建议持久化内容：

- task graph；
- node status；
- execution attempts；
- tool calls；
- artifacts；
- validation results；
- user clarification answers；
- runtime logs。

验收门控：

- 每个 TaskGraph 都有 stable id。
- 执行中断后能 resume。
- 手动查询 task graph 状态。
- completed task graph 可审计。
- failed task graph 保留 failure root cause。

### P4.2 Artifact Registry

目标：

- runtime 显式管理产物，而不是只把路径写在回答里。

验收门控：

- 文件写入必须注册 artifact。
- artifact 包含 type/path/createdAt/sourceNodeId/checksum optional metadata。
- final response 引用 artifact registry，而不是 LLM 自己猜路径。
- 删除或覆盖 artifact 必须经过 policy。

## 9. P5: Replanning And Recovery

### P5.1 Replan Decision

目标：

- 当 node 失败或验收失败时，runtime 能判断下一步。

建议决策：

- `retry_same`
- `retry_with_modified_args`
- `switch_capability`
- `ask_user`
- `skip_optional`
- `abort`

验收门控：

- transient tool failure 可按 retry policy 重试。
- permission denied 不得无限重试，必须 ask_user 或 abort。
- validation failed 必须触发 repair 或 re-execution。
- 连续失败达到上限后必须进入 failed/blocked，不得循环。

### P5.2 Repair Plans

目标：

- 支持对失败节点生成局部修复计划。

验收门控：

- 文件缺失 -> 重新执行 write_file。
- source coverage 不足 -> 追加 web/search node。
- schedule 参数缺失 -> clarification node。
- push channel 缺失 -> clarification node。
- shell 被 policy 拦截 -> 切换 allowed capability 或明确 blocked。

## 10. P6: Human-In-The-Loop Policy

目标：

- 对高风险、不确定、缺参数的任务进行明确交互。

验收门控：

- destructive action 必须确认。
- schedule 缺时间必须提问。
- push 缺 channel 必须提问。
- 任务目标歧义但可默认时，必须提供默认方案和可修改项。
- 用户回答后能恢复原 TaskGraph，而不是重新开始。

## 11. P7: Eval And Quality Gates

### P7.1 TaskGraph Eval Matrix

新增 eval dimensions：

- `taskEvaluation`
- `taskGraphPlanning`
- `capabilitySelection`
- `executionOrdering`
- `acceptanceValidation`
- `replanning`
- `durableState`

验收门控：

- 每个 dimension 至少 10 个 reviewed cases。
- 每个 P0-P5 能力至少有正例、反例、边界例。
- runtime quality dashboard 显示 task graph pass rate。
- `npm run runtime:quality` 纳入 task graph eval。

### P7.2 Runtime Trace Golden Tests

目标：

- 不只验证最终回答，还验证 runtime trace。

验收门控：

- golden trace 包含 TaskSpec、TaskGraph、node transitions、validators、artifacts。
- 关键 case 的 trace diff 可读。
- trace 中不允许出现“未执行但成功”的状态。

## 12. 分阶段实施计划

### Phase A: Spec And Planner Foundation

Status: completed.

范围：

- `TaskSpec`
- `AcceptanceCriteria`
- `TaskGraph`
- planner adapter
- basic eval cases

完成门控：

- 纯规划测试通过；
- 复杂请求能生成 TaskGraph；
- 无 capability / missing acceptance 会 blocked；
- 不接执行器也能看出完整任务计划。

实现说明：

- `packages/intent-runtime/src/taskGraph.ts` 提供 `TaskSpec`、`AcceptanceCriteria`、`TaskGraph`、`TaskNode` 以及规划/校验函数。
- `buildTaskSpec(intent)` 将 `IntentFrame` 升级为任务规格，明确 goal、kind、constraints、artifacts、acceptance。
- `buildTaskGraph(intent, spec, runtimeContext)` 将 `IntentSteps` 转成可执行 DAG，并基于 runtime context 处理 capability、memory boundary、channel、shell policy。
- planner 层不执行任何 side effect，只负责生成结构化计划和阻塞原因。

已通过门控：

- `npx vitest run packages/intent-runtime/src/taskGraph.test.ts packages/intent-runtime/src/packageApi.test.ts`
- `npm run runtime:build`

### Phase B: Executor And Validators

Status: completed.

范围：

- `TaskGraphExecutor`
- capability registry
- file/task/memory/channel validators
- final acceptance

完成门控：

- file write / task schedule / recall / push 四类任务由 TaskGraphExecutor 闭环；
- validator failed 阻止 success claim；
- execution trace 完整。

实现说明：

- `packages/intent-runtime/src/taskGraphExecutor.ts` 提供 `TaskGraphExecutor`、`DefaultTaskGraphCapabilityRegistry`、`TaskGraphCapabilityAdapter` 和 step-level validators。
- executor 按 DAG ready node 调度，required upstream 失败会阻塞 downstream。
- validator 覆盖 `tool_result`、`file_exists`、`file_contains`、`response_contains`、`source_count`、`memory_retrieved`、`task_scheduled`、`user_confirmed`。
- `finalResponseContract` 明确是否允许最终回答声称完成，避免 LLM 对未执行节点“自述成功”。
- execution observer 输出 graph/node start/result/acceptance/finish 事件，可用于日志和 dashboard。

已通过门控：

- `npx vitest run packages/intent-runtime/src/taskGraph.test.ts packages/intent-runtime/src/taskGraphExecutor.test.ts packages/intent-runtime/src/packageApi.test.ts`
- `npm run runtime:build`

### Phase C: Durable State And Replanning

Status: completed for package-level durable state, resume, artifact registry, and bounded recovery runtime.

范围：

- persistent task graph store
- resume
- retry / repair / ask_user

完成门控：

- 执行中断后能恢复；
- validation failure 能生成 repair plan；
- 用户补参后继续原任务图；
- 防止无限循环。

实现说明：

- `packages/intent-runtime/src/taskGraphState.ts` 提供 `TaskGraphExecutionSnapshot`、`TaskGraphExecutionStore`、`InMemoryTaskGraphExecutionStore`、`JsonFileTaskGraphExecutionStore` 和 `TaskArtifactRegistry`。
- snapshot 持久化 graph、node status、attempts、artifacts、validation results、events、clarification answers 和 failure root cause。
- `resumeStateFromSnapshot()` 支持跨 turn/后台任务恢复，已成功节点不会重复执行。
- artifact registry 显式管理产物，artifact 包含 `type/path/nodeId/sourceNodeId/createdAt/checksum` 等元数据。
- `packages/intent-runtime/src/taskGraphRecovery.ts` 提供 `ReplanDecision`、`decideTaskGraphRecovery()`、`applyReplanDecision()` 和 recovery resume state。
- `packages/intent-runtime/src/autonomousTaskRuntime.ts` 将 build graph、execute、snapshot、replan、resume 串成 `AutonomousTaskRuntime.run()`。
- recovery 支持 `retry_same`、`switch_capability`、`ask_user`、`skip_optional`、`abort`，并由 `maxRecoveryAttempts` 防止循环。

已通过门控：

- `npx vitest run packages/intent-runtime/src/taskGraphExecutor.test.ts packages/intent-runtime/src/taskGraphState.test.ts packages/intent-runtime/src/taskGraphRecovery.test.ts packages/intent-runtime/src/packageApi.test.ts`
- `npm run runtime:build`

### Phase D: Full Quality Gate

Status: completed.

范围：

- task graph eval matrix
- golden trace tests
- dashboard metrics
- runtime feedback promotion

完成门控：

- `runtime:quality` 包含 task graph gate；
- dashboard 能回答 task graph planning / execution / acceptance 是否退化；
- reviewed real-world failures 能进入 task graph eval。

实现说明：

- `scripts/run_task_graph_quality.ts` 输出 `evals/logs/task-graph-quality-latest.json/md`。
- 当前 task graph quality matrix 包含 70 个 reviewed deterministic cases，每个 dimension 10 个 reviewed cases。
- 每个 dimension 都包含 positive / negative / boundary case，覆盖 P0-P5 能力链路。
- 当前 quality dimensions 覆盖：
  - `taskEvaluation`
  - `taskGraphPlanning`
  - `capabilitySelection`
  - `executionOrdering`
  - `acceptanceValidation`
  - `replanning`
  - `durableState`
- `scripts/run_task_graph_quality.ts` 支持读取 `evals/task_graph/reviewed-task-graph-cases.jsonl`，用于把真实使用中的 reviewed task graph failures 纳入同一份 quality report。
- `packages/intent-runtime/src/taskGraphTrace.ts` 提供 golden trace 生成、trace health validation 和 readable diff。
- golden trace 覆盖 `TaskSpec`、`TaskGraph`、node transitions、validators、artifacts、final response contract，并检测“未执行但成功”的状态。
- `package.json` 新增 `task-graph:quality`，并已纳入 `runtime:quality`。
- `scripts/runtime_quality_dashboard.ts` 已读取 task graph quality report，并新增：
  - `task_graph_quality_eval_pass`
  - `task_graph_dimension_reviewed_coverage`
  - `task_graph_internal_gates_pass`
- runtime quality dashboard 显示每个 TaskGraph dimension 的 pass/total/reviewed 计数。

已通过门控：

- `npm run task-graph:quality`
- `npx tsx scripts/runtime_quality_dashboard.ts --gate`
- `npx vitest run packages/intent-runtime/src/taskGraph.test.ts packages/intent-runtime/src/taskGraphExecutor.test.ts packages/intent-runtime/src/taskGraphState.test.ts packages/intent-runtime/src/taskGraphRecovery.test.ts packages/intent-runtime/src/taskGraphTrace.test.ts packages/intent-runtime/src/packageApi.test.ts`
- `npm run runtime:build`

当前边界：

- 已完成 package-level autonomous task runtime 闭环；Jarvis 主请求路径尚未默认切到 `AutonomousTaskRuntime` 执行所有复杂任务。
- `JsonFileTaskGraphExecutionStore` 已提供通用持久化 adapter；Jarvis 后续可选择将其落盘目录接到自身 runtime state 目录。
- 真实使用失败样本的自动采集仍依赖 Jarvis 运行时反馈链路；P7 已提供 reviewed JSONL 入口和 dashboard gate，后续只需要把采集器输出接到 `evals/task_graph/reviewed-task-graph-cases.jsonl`。

## 13. Definition Of Done

达到本 roadmap 的完成标准时，Jarvis 应满足：

- 每个复杂任务都有明确 `TaskSpec`。
- 每个多步骤任务都有可审计 `TaskGraph`。
- 每个 executable node 绑定 capability 和 executor。
- 每个 required node 有 acceptance criteria。
- runtime 根据 validator 判断完成，而不是相信 LLM 自述。
- final response 只能基于 TaskGraph execution state 声称成功。
- 失败时能 retry / replan / ask user / abort，且不会循环。
- 跨 turn 和后台任务可恢复。
- eval 和 dashboard 能持续发现 planning / execution / acceptance regression。

## 14. 当前优先级建议

最高优先级：

1. P0 `TaskSpec + AcceptanceCriteria`
2. P1 `TaskGraph Planner`
3. P3 `Acceptance Runtime`

原因：

- 没有任务规格，拆解会继续依赖 LLM 自由发挥。
- 没有 TaskGraph，执行阶段无法稳定编排。
- 没有 Acceptance，Jarvis 仍可能“看起来做了”，但 runtime 无法证明完成。

P2 executor 可以先只覆盖 file/task/recall/push 四类 capability；P4/P5 持久化和 replanning 在基础闭环稳定后推进。
