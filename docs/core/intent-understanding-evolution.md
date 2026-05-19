# Jarvis 意图理解能力演进方案

本文档记录 Jarvis 从当前语义路由实现，演进为“强意图理解系统”的路线图。

## 当前状态

Jarvis 当前使用本地 Ollama 模型生成 `IntentFrame`，再由代码层执行确定性
guardrails。相比纯关键词路由，这个设计已经更稳，因为它要求本地模型输出结构化
语义证据：

- `personalContext`
- `memoryRecall.target`
- `actionRequest`
- `entityHints`

随后代码会对模型输出做归一化，并修正一些关键失败模式，例如：

- 把外部历史事件误判成个人记忆召回；
- 把技术缩写误判成股票 ticker；
- 把泛泛分析误判成明确 agent delegation；
- 把低置信度 external 请求保守升级为 mixed。

这个方向是正确的，但它还不是成熟的意图理解层。下一阶段需要让意图理解变得
可评测、可修复、可解释，并且足够明确地服务后续 planning、memory injection
和 agent routing。

## 目标状态

一个强意图理解系统应该具备这些能力：

- 输出用户目标的结构化表示，而不只是几个分类标签；
- 区分主意图和次级意图；
- 明确请求依赖哪些上下文来源：近期会话、长期记忆、本地 workspace、外部世界、
  工具或专门 agent；
- 显式暴露歧义和风险，而不是静默猜测；
- 当本地模型输出 schema 不合法时，可以校验和修复；
- 持续用真实本地模型和真实案例评测；
- 给下游模块足够的信息，避免 memory、tool、agent 各自重新理解一遍用户请求。

## 优先级路线图

### P0：建立真实模型 Intent Eval

最高优先级是建立 intent evaluation harness，而且要跑真实 Ollama 模型，不只
验证 mock 结果。

评测数据集应覆盖：

- 个人记忆召回 vs 外部历史事件；
- 当前会话指代 vs 长期记忆召回；
- `chat` vs `analyze` vs `execute`；
- 明确 delegation vs candidate agent 推荐；
- schedule/reminder；
- 金融 ticker vs 技术缩写；
- mixed 和多步骤请求。

每条 case 应标注期望值：

- `subject`
- `taskType`
- `semanticEvidence.personalContext`
- `semanticEvidence.memoryRecall.target`
- `semanticEvidence.actionRequest`
- `semanticEvidence.entityHints`
- 是否需要 memory、tool、external knowledge

评测框架应支持比较多个本地模型：

- `gemma4:e2b`
- `gemma4:e4b`
- `qwen3:8b`
- `qwen3.5:9b`
- `qwen3:0.6b`

指标应该按维度统计，而不是只给整体 pass/fail。这样可以看出某个模型到底是弱在
memory recall、entity typing、delegation，还是 action detection。

### P1：升级 IntentFrame Schema

当前 `IntentFrame` 更像分类结果。强意图理解系统需要表达“用户到底想完成什么”。

候选结构：

```ts
type RichIntent = {
  userGoal: string;
  primaryAction:
    | "answer"
    | "recall"
    | "analyze"
    | "modify"
    | "run"
    | "schedule"
    | "delegate";
  targets: Array<{
    type:
      | "memory"
      | "file"
      | "code"
      | "external_entity"
      | "agent"
      | "calendar"
      | "current_context";
    value: string;
  }>;
  contextDependency: {
    recentConversation: boolean;
    longTermMemory: boolean;
    localWorkspace: boolean;
    externalWorld: boolean;
  };
  ambiguity: Array<{
    field: string;
    reason: string;
    severity: "low" | "medium" | "high";
  }>;
  riskLevel: "low" | "medium" | "high";
};
```

为了降低迁移风险，现有 `subject` 和 `taskType` 可以继续保留为兼容字段，同时
逐步引入更丰富的 intent 结构。

### P1：Schema 校验与修复

本地小模型一定会偶尔漏字段、返回非法 JSON，或产出自相矛盾的 evidence。当前
normalize 能兜底，但强系统应该主动校验和修复模型输出。

实现方向：

- 为 intent 模型输出定义严格 schema；
- 在 normalize 前先校验 raw model output；
- 校验失败时 retry 一次，使用 repair prompt，只要求模型修复 JSON 结构；
- repair 仍失败时进入保守 fallback；
- 记录 repair 次数、校验错误、fallback 原因。

这会让模型切换更安全，尤其是在尝试 `qwen3:0.6b` 这类更小模型时。

### P2：支持 Multi-Intent

真实用户请求经常包含多个意图：

> 查 NVDA 最近财报，整理成 markdown，明天提醒我复盘

这同时包含外部分析、报告写入和定时提醒。单一 `taskType` 无法完整表达。

如果正确识别出了 Multi-Intent，后续执行阶段也需要逐步调整。Multi-Intent 的价值
不在于“多贴几个标签”，而是让 Jarvis 知道一个用户请求里有多个不同性质的子任务，
并能在后续按顺序、依赖、风险和上下文需求处理它们。

例如：

> 查 NVDA 最新财报，结合我的风险偏好写成 markdown，明天提醒我复盘

至少包含：

- `analyze`：分析 NVDA 财报；
- `recall`：使用用户风险偏好；
- `execute`：写入 markdown；
- `schedule`：创建明天提醒。

如果执行阶段仍只看一个 `taskType`，系统可能只回答分析内容，漏掉写文件或提醒；也
可能因为主意图被判成 `execute` 而忽略外部分析和个人上下文。

因此 Multi-Intent 应分阶段落地。

阶段一：识别和暴露 intent steps，不改主执行循环。

- 继续保留 `taskType` 作为主意图；
- 新增 `intentSteps` 表示完整子任务；
- `IntentFrame` 兼容旧字段；
- 将 `<intent_plan>` 注入 system prompt，让主 LLM 明确看到完整任务结构；
- memory / clarification / executor 先不做大改，避免一次性改动执行引擎。

当前阶段一的落地边界：

- 本地意图模型直接输出 `intent_steps`；
- Resolver 会校验、归一化模型输出；
- 当模型漏掉 steps 时，Resolver 会根据 subject、memory recall、entity hints、action cue、
  schedule cue、candidate agents 做确定性补全；
- 单步骤请求不注入 `<intent_plan>`，避免污染普通问答；
- 多步骤请求注入 `<intent_plan>`，但执行仍由主 LLM 在一个 turn 内完成。

候选结构：

```ts
type IntentStep = {
  id: string;
  type: "chat" | "recall" | "analyze" | "execute" | "delegate" | "schedule";
  action: string;
  target: string;
  dependsOn: string[];
  requiresConfirmation?: boolean;
  riskLevel?: "low" | "medium" | "high";
};
```

阶段二：让 policy 层开始消费 steps。

- 任一 step 是 `schedule` 且缺时间，则 clarification policy 追问；
- 任一 step 是 `execute` 且 action/target 不清楚，则追问；
- 任一 step 需要 memory，则 memory policy 允许必要的记忆注入；
- external analyze + personal recall 同时存在时，subject 应保持 `mixed`；
- delegate step 可保留 candidate agent，但不一定自动启动。

阶段三：再引入真正的 orchestrated execution。

```ts
type ExecutionPlan = {
  steps: IntentStep[];
  mode: "single_llm" | "orchestrated";
};
```

短期仍使用 `single_llm`：主模型阅读 `<intent_plan>` 后自行完成。长期才考虑 Jarvis
按 step 主动调 retrieval、web/search、file write、schedule tool 或 subagent。

这个分阶段策略可以让 Jarvis 先获得 Multi-Intent 的理解收益，又不会立即引入复杂
执行器风险。

### P2：分维度置信度

当前 `confidence` 是整体值，信息太粗。强意图理解系统应该按维度记录置信度：

```ts
type IntentConfidence = {
  overall: number;
  subject: number;
  taskType: number;
  memoryTarget: number;
  action: number;
  entity: number;
};
```

这能支持更细的 guardrails：

- `subject` 低置信度时，使用 mixed-context 处理；
- `memoryTarget` 低置信度时，避免激进 recall；
- `action` 低置信度时，执行工具前先确认；
- `entity` 低置信度时，不自动路由到投资分析 agent。

### P3：Intent-Aware Memory Injection

Memory injection 应该依赖 intent 结构，而不是只看 `personal` / `external` 这种粗
标签。

目标行为：

- `external` 且无 personal context：不注入个人 facts/memories；
- `external_past_event`：不注入长期记忆，除非同时存在 personal context；
- `current_context_reference`：优先使用近期会话，不急着查长期 memory；
- `user_memory`：查 facts 和 vector memories；
- 风格/格式偏好请求：只注入 style facts；
- `mixed`：按 target 分桶注入，而不是一股脑注入所有记忆。

这能降低 context 污染，也让 recall 行为更容易解释。

### P3：模型 A/B 与 Fallback 策略

Intent Understanding 不应该只能绑定一个本地模型。更好的策略是区分快模型和
准模型。

建议配置：

```json
{
  "routing": {
    "intentModels": {
      "fast": "gemma4:e2b",
      "accurate": "qwen3.5:9b",
      "experimental": "qwen3:0.6b"
    }
  }
}
```

正常请求走 fast model。以下场景升级到 accurate model 二次判断：

- schema 校验失败；
- 置信度低；
- 请求风险高；
- memory/action/entity evidence 冲突；
- eval 数据表明 fast model 在该类请求上较弱。

这比全量替换 router 模型更安全。

### P4：Clarification Policy

强意图理解系统不应该永远猜。高风险或低置信度时，应该向用户澄清。

需要澄清的场景：

- action target 不明确；
- schedule 时间不完整；
- requested agent 不明确；
- memory recall 范围模糊；
- tool execution 有风险；
- multi-intent 的执行顺序不明确。

目标不是多问，而是在猜错代价高的时候问。

### P4：可观测性

需要为完整 intent pipeline 添加结构化日志：

- raw model output；
- schema validation / repair 结果；
- normalized intent；
- guardrail modifications；
- memory injection decision；
- selected model；
- candidate agents；
- confidence by dimension；
- final behavior。

初期可以先写结构化 JSON logs，不急着做 UI。

## 建议执行顺序

1. 建立真实模型 intent eval harness。
2. 增加 schema validation 与 repair。
3. 升级 `IntentFrame`，加入更丰富的 goal/action/context 字段。
4. 支持 multi-intent。
5. 增加分维度 confidence。
6. 让 memory injection 完全 intent-aware。
7. 增加模型 A/B 与 fallback。
8. 增加 clarification policy。
9. 增加结构化 observability。

前三个最高杠杆项是：真实模型 eval、schema validation/repair、更丰富的
`IntentFrame` schema。完成这三项后，Jarvis 的 Intent Understanding 才会从
“可用的语义路由”进入“可持续变强的意图理解层”。
