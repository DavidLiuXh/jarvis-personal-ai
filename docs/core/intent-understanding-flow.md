# Jarvis 意图理解层全链路与架构设计

本文档说明 Jarvis 在收到一条用户输入后，如何逐层理解意图、选择模型、决定是否追问、决定是否注入记忆、构造上下文、执行工具，并最终返回响应。

如果从更大的可复用架构视角看，意图理解层也是通用 Memory Runtime 的入口控制器。相关三层记忆模型、Memory Contract 和迁移路线见
[`docs/core/universal-memory-layer.md`](./universal-memory-layer.md)。

它同时覆盖三件事：

- 当前 Intent Understanding 层的实际运行链路；
- 最近围绕 `IntentFrame`、policy layer、confidence calibration、feedback loop 做的架构改造；
- 当前距离工业级强意图理解系统的差距和后续演进路线。

## 0. 总览

一次普通消息的主路径在 `JarvisAgent.processMessage()` 中完成。核心流程如下：

```mermaid
flowchart TD
    A["用户输入 userPrompt"] --> B["命令前置拦截"]
    B --> C{"是否为 !task / !skill / 后台 / agent: 显式请求"}
    C -- "是" --> C1["走专用处理路径并返回"]
    C -- "否" --> D["LocalModelRouter.route()"]
    D --> E["IntentResolver.resolve() 生成 IntentFrame"]
    E --> F["确定性 policy layer 修正 IntentFrame"]
    F --> G["模型路由: complexityScore 选择 pro/flash"]
    G --> H["ClarificationPolicy"]
    H --> I{"是否需要阻塞式追问"}
    I -- "是" --> I1["ask_user / 文本澄清问题"]
    I1 --> I2{"用户是否回答"}
    I2 -- "回答" --> I3["合并澄清答案并重新 route"]
    I2 -- "未回答/无通道" --> I4["结束本轮"]
    I -- "否" --> J["Topic Shift 处理"]
    I3 --> J
    J --> K["IntentAwareMemoryPolicy"]
    K --> L["检索 facts / summary / prewarm memories / skills"]
    L --> M["MemoryInjectionPlanner 控制预算并构造注入片段"]
    M --> N["重建 system prompt"]
    N --> O["sendMessageStream 主 LLM 响应"]
    O --> P{"是否产生 tool calls"}
    P -- "是" --> Q["ToolRouter.route() 执行工具"]
    Q --> O
    P -- "否" --> R["返回最终响应"]
    R --> S["异步 memory enqueue / distill / history compression"]
```

主路径对应的核心文件：

- `jarvis/src/core/agent.ts`
- `jarvis/src/core/localModelRouter.ts`
- `jarvis/src/core/intentResolver.ts`
- `jarvis/src/core/clarificationPolicy.ts`
- `jarvis/src/core/intentAwareMemoryPolicy.ts`
- `jarvis/src/core/memoryInjectionPlanner.ts`
- `jarvis/src/core/toolRouter.ts`

## 1. 设计目标

Jarvis 的意图理解层不是一个简单分类器。它的目标是把用户自然语言请求转换成一个可被
后续模块稳定消费的语义契约。

这个语义契约至少要回答：

- 用户请求主要依赖个人上下文、外部知识，还是两者都有；
- 用户是在聊天、召回记忆、分析、执行、委派，还是创建提醒；
- 请求是否引用当前对话、长期记忆、本地 workspace、外部世界或专门 agent；
- 是否存在多个子意图；
- 是否存在不应静默猜测的歧义或风险；
- 是否应该注入 facts、summary、prewarm memories；
- 是否应该追问；
- 哪些 deterministic policy 修改过模型输出，以及为什么修改。

这种设计的核心判断是：

> LLM 负责开放语义理解，代码负责可解释性、一致性、边界控制和回归稳定性。

如果完全依赖主 LLM 自由发挥，下游 memory、tool、agent 会各自重新理解用户请求，行为
不可解释，也难以回归。如果完全依赖关键词规则，中文里的“之前”“上次”“记得”“帮我处理”
这类多义表达又会造成大量误判。因此 Jarvis 采用“本地模型语义判断、确定性 policy 治理
和 eval 回归”组合的结构。

## 2. 分层设计原则

Jarvis 的 intent understanding 被拆成多个相对独立的层级。这样做不只是为了代码整洁，
而是为了把“概率判断”和“确定性治理”分开，让每层承担不同责任。

### 2.1 本地模型层：负责语义判断

用途：

- 从用户输入和近期 history 中提取 `IntentFrame`；
- 判断 subject、taskType、memoryTarget、topic relation；
- 输出 rich intent、entity hints、intent steps 和 confidence。

原因：

- 这些判断依赖自然语言理解，不能靠关键词完整覆盖；
- 中文里的“之前”“记得”“上次”“帮我处理一下”高度多义，模型比规则更适合给出初始语义解释；
- 将模型限制在“产生结构化语义证据”，而不是直接决定所有下游行为，可以降低模型误判的破坏范围；
- 本地模型可替换，后续可以通过 eval 对比 `gemma`、`qwen` 等模型，而不需要重写下游逻辑。

### 2.2 Schema validation / repair 层：负责输入可信度边界

用途：

- 校验本地模型输出是否符合 expected schema；
- 对非法 JSON 或缺字段结果进行 repair；
- repair 失败时进入保守 fallback；
- 记录 repair/fallback 现象，作为模型稳定性指标。

原因：

- 小模型在长 schema 下天然会出现非法 JSON、漏字段、字段类型错误；
- 如果把不合法输出直接交给 resolver，下游会同时承担“语义错误”和“结构错误”，问题难定位；
- 单独抽出 validation/repair 可以把模型能力问题显式化，便于统计 repair rate 和模型切换风险；
- fallback 策略需要稳定、确定、可测试，不能依赖模型再猜一次。

### 2.3 Policy layer：负责确定性语义治理

用途：

- 对模型输出执行稳定的 normalize、guardrail、override、finalize；
- 统一处理 recall/personal/mixed、external past event、ticker false positive、delegate false positive 等边界；
- 输出 `policyTrace`，记录每次修正的 rule、reason、before/after。

原因：

- 模型输出是概率性的，但 memory injection、tool execution、agent routing 需要可预测行为；
- 一些错误的代价不对称，例如把 external 问题误判为 personal 会污染上下文，把 execute 误判为 chat 会漏执行；
- 如果 guardrail 分散在 resolver 各处，优先级、覆盖率和回归路径都会变得不可控；
- 独立 policy layer 让每条规则都有 id、priority、reason 和测试 case，便于 code review 和 eval 回归。

### 2.4 Eval / calibration 层：负责质量度量

用途：

- 用真实本地模型跑 intent eval；
- 统计维度 pass rate、tag pass rate、policy reason coverage；
- 基于 pass/fail 分布生成 confidence calibration；
- 对 core policy trace 做 baseline compare。

原因：

- intent understanding 的质量不能只靠几个手工案例判断；
- 模型升级、prompt 调整、schema 扩展都可能导致“结果还对，但路径变了”，这类 drift 需要被看见；
- confidence 阈值如果只靠经验，会在数据分布变化时失效；
- baseline 和 calibration 把“是否稳定”从主观感觉变成可重复的工程指标。

### 2.5 Feedback loop 层：负责把真实失败变成资产

用途：

- 把 eval 失败输出成 JSONL candidate；
- 保留 prompt、history、failed checks、observed intent、clarification decision；
- 让失败样本经过人工审核后进入正式 regression case。

原因：

- 真实用户失败通常比预设测试更能暴露系统边界；
- 如果失败只停留在日志里，后续修改很容易再次引入同类问题；
- candidate 格式把“发现问题”到“补充 eval”之间的成本降下来；
- 长期看，feedback loop 是 intent system 从项目功能走向运营系统的关键。

## 3. 当前架构能力概览

Jarvis 当前使用本地 Ollama 模型生成 `IntentFrame`，再由代码层执行 deterministic
policies。相比纯关键词路由，这个设计要求本地模型输出结构化语义证据：

- `personalContext`
- `memoryRecall.target`
- `actionRequest`
- `entityHints`
- `richIntent`
- `intentSteps`
- `confidenceByDimension`

随后代码会对模型输出做 schema validation、repair、normalize 和 policy 修正，例如：

- 把外部历史事件误判成个人记忆召回；
- 把技术缩写误判成股票 ticker；
- 把泛泛分析误判成明确 agent delegation；
- 把低置信度 external 请求保守升级为 mixed；
- 把多步骤请求暴露为 `intentSteps` 并注入 `<intent_plan>`；
- 根据 intent-aware memory policy 决定 facts、summary、prewarm memories 是否可注入。

当前系统已经超过“弱规则路由”和“完全依赖 LLM 自由发挥”，更准确地说，它是：

> 一个有 schema、有 repair、有 deterministic policy、有 eval、有 policy trace 的中级语义路由和意图治理系统。

它还没有完全达到工业级强意图理解系统，主要差距在执行编排、长期运营指标、跨模型稳定性、
真实线上回灌和 step-level contract。

## 4. 最近一次架构调整：Policy Trace、置信度校准与失败样本闭环

最近这轮改动的核心目标不是继续增加零散 guardrail，而是把 intent understanding 里的
确定性修正规则，升级成可解释、可回归、可运营的 policy layer。

### 4.1 Policy trace 标准化

每一条 deterministic policy 现在都必须带稳定的 reason metadata：

```ts
type IntentPolicyReason = {
  code: string;
  category:
    | "semantic_evidence"
    | "subject_boundary"
    | "task_boundary"
    | "agent_routing";
  severity: "info" | "warning" | "critical";
};
```

过去只有 `reasonCode`，适合人工阅读，但不利于统计和 eval 分桶。现在每条
`policyTrace` 同时包含：

- `ruleId`
- `stage`
- `priority`
- `reasonCode`
- `reason.code`
- `reason.category`
- `reason.severity`
- `before`
- `after`

这样设计的原因是：`reasonCode` 适合单点调试，但不适合长期运营。工业级系统需要回答：

- 最近 subject boundary 的 critical 修正规则是否变多了；
- 某个模型是否更容易触发 agent routing 修正；
- 某次改动是否改变了 policy path。

这些问题都要求 reason 既稳定又可聚合。

### 4.2 Confidence calibration

eval runner 会按 confidence dimension 聚合真实模型输出：

- 样本数；
- pass 样本数；
- fail 样本数；
- pass 最低值；
- pass P10；
- pass 平均值；
- fail 最高值；
- suggested floor；
- 当前默认 floor。

这一步暂时不直接改 runtime 阈值。它的价值是让 Jarvis 从“经验阈值”进入“数据支持的
阈值治理”。当 eval 样本足够多时，可以基于真实 pass/fail 分布调整
`LOW_CONFIDENCE_THRESHOLD`、clarification threshold、entity confidence threshold 等关键
阈值。

这样设计的原因是：confidence 本身不是事实，它只是模型对自己判断的估计。如果不把
confidence 和实际 pass/fail 关联起来，阈值就是经验常量。calibration 层把 confidence
变成可校准信号，使后续阈值调整有数据依据。

### 4.3 线上反馈闭环

eval runner 支持把失败样本输出成 JSONL candidate：

```bash
npx tsx scripts/run_intent_evals.ts \
  --models gemma4:e2b \
  --write-eval-candidates evals/intent/candidates/intent-eval-candidates-latest.jsonl
```

candidate 会保留：

- 原始 prompt；
- history；
- tags；
- failed checks；
- observed intent；
- clarification decision；
- 可继续补齐 expected 的 `candidateCase` skeleton。

这让真实失败可以从“日志里偶然发现的问题”变成“可审核、可补标、可回归”的测试资产。
后续如果把线上日志中的失败样本接入同一格式，就能形成稳定的反馈闭环：

> 线上失败 → 生成 candidate → 人工审核补 expected → 进入 eval case → 后续每次修改回归。

这样设计的原因是：intent system 的真实难点来自长尾表达。人工预设 case 永远不可能覆盖
所有长尾，必须让真实失败样本进入测试资产。candidate 不是直接变成测试，因为 observed
output 不等于 expected truth，中间需要人工审核；但它把回灌路径标准化了。

### 4.4 本次实现边界

已经完成：

- policy registry 校验 reason metadata；
- `IntentFrame.policyTrace` 输出标准化 reason；
- policy trace baseline 升级到 v2，并比较 `reason.category` / `reason.severity`；
- eval markdown/json 报告展示 policy reason code 的 category 和 severity；
- eval 报告生成 confidence calibration 表；
- eval 失败时生成 JSONL candidate；
- 单元测试覆盖 policy reason metadata 和 trace 输出；
- 使用 `gemma4:e2b` 跑通 core baseline、baseline compare、full eval 和失败样本 smoke test。

尚未完成：

- runtime 阈值还没有自动读取 calibration 结果；
- 线上真实日志还没有自动接入 candidate 生成流程；
- 还没有 dashboard 展示长期趋势；
- 还没有对不同模型建立长期稳定性曲线。

因此当前状态是：policy layer 已经具备工业级治理骨架，但 confidence 和 feedback loop
仍处于“可生产数据、可人工闭环”的阶段，还没有完全自动化运营。

## 5. 第一层：输入前置拦截

Jarvis 并不是所有输入都先交给 LLM。`processMessage()` 前面有几类快速路径。

### 5.1 `!clear`

`!clear` 会压缩或清空当前会话历史：

- 如果有 summarizer，则把历史压缩为摘要；
- 清掉 raw chat history；
- 保留 `conversationSummary` 供后续 summary chunk 检索；
- 不进入 intent routing。

### 5.2 `!task`

`!task` 命令直接交给 `TaskCommandHandler`。

这类请求不需要 LLM，也不需要 memory injection。

### 5.3 `!skill`

`!skill` 命令直接交给 `SkillCommandHandler`。

### 5.4 后台任务前缀

如果输入形如：

- `后台: ...`
- `background: ...`
- `async: ...`
- `bg: ...`

会进入 `BackgroundTaskRunner`，立即返回后台任务已启动，本轮主 LLM 不继续执行。

### 5.5 显式 `agent:`

如果输入以 `agent:` 开头，Jarvis 会绕过普通 LLM 路径，调用 `LocalModelRouter.routeAgentCall()` 做显式 agent routing。

这一点和“自然语言推荐候选 agent”不同：

- `agent:` 是用户明确要求启动 agent；
- 普通输入里的 `candidateAgents` 只是 intent 结果里的建议，不等于自动委派。

## 6. 第二层：LocalModelRouter

普通输入进入 `LocalModelRouter.route(userPrompt, history)`。

它做两件事：

1. 调用 `IntentResolver` 生成完整 `IntentFrame`；
2. 根据 `complexityScore` 选择实际主模型。

输出结构是 `RoutingResult`：

```ts
type RoutingResult = {
  model: string;
  score: number;
  classifierReason: string;
  decision: string;
  source: "local-router/ollama" | "local-router/fallback";
  querySubject: "personal" | "external" | "mixed";
  timeWindowDays: number | null;
  dateFrom: string | null;
  dateTo: string | null;
  resolvedDateRange: { from: number; to: number } | null;
  topicShifted: boolean;
  intent: IntentFrame | null;
};
```

如果本地模型失败、超时、JSON 无法修复，router 会 fallback：

- `model = proModel`
- `querySubject = mixed`
- `intent = null`

这里的 fallback 是保守策略：宁可使用强模型和 mixed subject，也不要把可能需要个人上下文的请求误判成 external。

## 7. 第三层：IntentResolver

`IntentResolver` 是当前意图理解层的核心。它不是简单分类器，而是“本地模型 + schema 归一化 + focused extractors + deterministic guardrails”的组合。

### 7.1 本地模型生成 IntentFrame seed

本地 Ollama 模型被要求输出一个 raw JSON object。它要同时判断：

- `query_subject`
- `task_type`
- `needs_external_knowledge`
- `needs_tool`
- `needs_scheduling`
- `candidate_agents`
- `confidence`
- `confidence_by_dimension`
- `semantic_evidence`
- `classifiers`
- `rich_intent`
- 时间窗口和 topic shift

这里本地模型不是直接控制执行，而是产出一个候选结构。

### 7.1.1 多维 classifier 层

当前 `IntentFrame` 不再只依赖 `query_subject`、`task_type`、`topic_shifted` 这些扁平字段。
本地模型会先输出 `classifiers`：

- `classifiers.subject`：独立判断 `personal` / `external` / `mixed`；
- `classifiers.task`：独立判断主任务类型；
- `classifiers.memory`：独立判断 memory target；
- `classifiers.action`：独立判断 CRUD / lifecycle action；
- `classifiers.topic`：独立判断 topic boundary；
- `classifiers.steps`：独立判断是否是 multi-intent。

这么做的原因是：自然语言请求经常同时包含“语义主题”“操作流程”“上下文引用”“输出形式”。
如果让本地模型一次性给出一个总判断，它容易把不同维度互相污染，例如：

- 两个请求都包含“收集、分析、保存”，但语义领域已经从 AI Agent 切到美国市场；
- 前一轮是美团投资报告，后一轮是 LoRA 方法比较，都是“分析”，但主题完全不同；
- 当前请求有一个实体名，并不代表它一定是上一轮报告的 drilldown。

因此 topic classifier 被要求显式输出：

```ts
{
  historyDomain: string;
  currentDomain: string;
  semanticDomainContinuity: boolean;
  workflowContinuity: boolean;
  entityContinuity: boolean;
  sharedEntities: string[];
  sharedWorkflow: string[];
  requiresPreviousContext: boolean;
  relation: TopicRelation;
  topicShifted: boolean;
}
```

关键约束：

- `workflowContinuity=true` 不能单独证明 `topicShifted=false`；
- 只有 `semanticDomainContinuity=true`、`entityContinuity=true` 或 `requiresPreviousContext=true` 时，才允许认为 topic 连续；
- 如果模型只能解释为“同样是分析/报告/保存”，应输出 `topicShifted=true`。

Resolver 会优先读取 `classifiers`，再投影到兼容字段 `subject`、`taskType`、`semanticEvidence.memoryRecall.target` 和 `topicAnalysis`。
旧模型或旧 eval case 如果没有输出 `classifiers`，则继续从 legacy 字段回填，保持兼容。

### 7.2 IntentFrame 的核心字段

当前标准化后的 `IntentFrame` 大致分为几组。

#### 请求主体

```ts
subject: "personal" | "external" | "mixed";
```

含义：

- `personal`：主要依赖用户历史、偏好、过去对话、长期记忆；
- `external`：纯外部世界问题，不依赖用户个人上下文；
- `mixed`：同时需要个人上下文和外部知识。

这个字段会影响 memory injection，是最关键字段之一。

#### 任务类型

```ts
taskType:
  | "chat"
  | "recall"
  | "analyze"
  | "execute"
  | "delegate"
  | "schedule";
```

含义：

- `chat`：普通对话回答；
- `recall`：回忆过去对话或用户记忆；
- `analyze`：分析、比较、判断、推荐；
- `execute`：修改文件、运行命令、完成操作；
- `delegate`：委派给专门 agent；
- `schedule`：提醒、定时、周期任务。

#### 能力需求

```ts
needsMemory: boolean;
needsExternalKnowledge: boolean;
needsTool: boolean;
needsScheduling: boolean;
```

这些字段给下游 policy 使用。

例如：

- `needsMemory=false` 会使 intent-aware memory policy 跳过 facts/summary/prewarm；
- `needsScheduling=true` 会让 clarification policy 更关注时间是否明确；
- `needsTool=true` 表示主 LLM 可能需要工具执行。

#### 时间范围

```ts
timeWindowDays: number | null;
dateFrom: string | null;
dateTo: string | null;
resolvedDateRange: { from: number; to: number } | null;
```

用于类似：

- 昨天我们聊了什么；
- 上周讨论过什么；
- 4 月 9 日的记录。

`resolvedDateRange` 优先级最高，因为它是代码侧解析出来的精确时间范围。

#### topic shift

```ts
topicShifted: boolean;
referencesRecentHistory: boolean;
topicAnalysis: {
  history: {
    label: string;
    evidence: string[];
    sourceTurns: number[];
    confidence: number;
  };
  current: {
    label: string;
    evidence: string[];
    sourceTurns: number[];
    confidence: number;
  };
  relation:
    | "same_topic"
    | "subtopic"
    | "adjacent_topic"
    | "new_topic"
    | "current_context_reference"
    | "unknown";
  relationReason: string;
  confidence: number;
  lowGrounding: boolean;
}
```

用于判断是否清空当前 chat history。

关键规则：

- 如果用户明确引用当前上下文，比如“继续”“这个”“刚才那个”，不能清空历史；
- 如果是新主题，且不是第一轮，可以清空历史，降低旧话题污染。
- `history.label` 和 `current.label` 是模型对最近历史和当前请求的短标签；
- `evidence` 是支撑标签的证据片段，优先来自原始用户输入或最近 history；
- 如果模型漏掉 evidence，normalize 层会用当前 prompt 或相关 history turn 做 fallback；
- `relation` 比自由文本 topic label 更重要，下游优先看关系类型和 `referencesRecentHistory`。

#### 分维度置信度

```ts
confidenceByDimension: {
  subject: number;
  taskType: number;
  memoryTarget: number;
  action: number;
  entityHints: number;
  topicShift: number;
  richIntent: number;
}
```

这是后续 guardrails 的基础。Jarvis 不只看 overall confidence，而是按维度处理。

例如：

- `memoryTarget` 低置信度：禁用 aggressive memory prewarm，必要时追问；
- `action` 低置信度：执行类任务先追问；
- `subject` 低置信度：更保守地按 mixed 处理。

#### semanticEvidence

```ts
semanticEvidence: {
  personalContext: {
    present: boolean;
    reason: string;
    span?: string;
  };
  memoryRecall: {
    present: boolean;
    target:
      | "conversation_history"
      | "user_memory"
      | "external_past_event"
      | "current_context_reference"
      | "none";
    reason: string;
    span?: string;
  };
  actionRequest: {
    present: boolean;
    action:
      | "read"
      | "write"
      | "run"
      | "schedule"
      | "delegate"
      | "none";
    object?: string;
  };
  entityHints: {
    tickers: string[];
    technicalTerms: string[];
    peopleOrCompanies: string[];
  };
};
```

这部分解决了单纯关键词判断容易误伤的问题。

例如：

- “上次苹果发布会发布了什么”应是 `external_past_event`，不是个人记忆召回；
- “你记得保存这个文件吗”不是 memory recall；
- “分析 ONNX 的基本面”不能因为 ONNX 是大写词就当股票 ticker；
- “结合我的风险偏好分析 NVDA”是 mixed，不是 external。

#### richIntent

```ts
richIntent: {
  userGoal: string;
  domain:
    | "task_management"
    | "memory_management"
    | "code_modification"
    | "system_control"
    | "general_chat"
    | "external_knowledge"
    | "investment_analysis"
    | "unknown";
  action:
    | "create"
    | "read"
    | "update"
    | "delete"
    | "list"
    | "append"
    | "rename"
    | "pause"
    | "resume"
    | "cancel"
    | "send"
    | "resend"
    | "forward"
    | "retry"
    | "forget"
    | "consolidate"
    | "execute"
    | "schedule"
    | "answer"
    | "analyze"
    | "delegate"
    | "recall";
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
      | "task"
      | "channel"
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

这是从“分类标签”升级到“结构化用户目标”的关键。

下游现在主要用它做：

- clarification policy；
- memory injection policy；

`domain/action` 是 CRUD-aware intent 的第一层。它解决的是“同样是 schedule，创建提醒和删除提醒不是同一种风险”的问题。
例如：

- `task_management.create`：通常需要时间；
- `task_management.delete`：不需要时间，但需要明确目标，且风险更高；
- `memory_management.recall`：可以直接召回；
- `memory_management.forget/delete`：需要明确目标和确认；
- `code_modification.update`：需要 workspace/tool 能力；
- `task_management.send` + `channel` target：应走 `push_to_channel`。

这样设计的原因是：`taskType` 是兼容旧路由的粗分类，不能表达对象生命周期。`domain/action`
把“做什么”和“对什么做”显式化，clarification、execution plan、eval 才能按同一套语义工作。

- prewarm query 构造；
- 判断是否依赖长期记忆、当前上下文、本地 workspace、外部世界。

### 7.3 JSON 解析与修复

本地小模型可能输出非法 JSON。当前流程是：

1. 从文本中提取看起来像 JSON object 的片段；
2. 用 predicate 判断是否符合 intent 结果形状；
3. 如果失败，调用一次 repair prompt；
4. repair 成功则继续 normalize；
5. repair 失败则抛错，由 `LocalModelRouter` fallback。

这让 Jarvis 可以使用较小本地模型，同时把 schema 风险控制在意图层内部。

### 7.4 Focused Extractors

主 intent JSON 之后，还可能按需调用更小范围的 focused extractor。

当前主要有两类：

- memory target extractor；
- entity hints extractor。

它们不是并发跑，而是按需、顺序执行，避免本地模型压力过大。

#### memory target extractor

用于修正“是否在问记忆，以及问哪类记忆”。

典型修正：

- `external_past_event`：外部过去事件，不应升级为 personal；
- `conversation_history`：问我们之前聊过什么；
- `current_context_reference`：指代当前对话；
- `user_memory`：问用户长期事实、偏好、历史。

#### entity hints extractor

用于区分股票 ticker 和技术缩写。

例如：

- `NVDA` 可以是 ticker；
- `ONNX`、`RAG`、`API`、`LLM` 应更多进入 technicalTerms；
- 不再单纯依赖 `/\b[A-Z]{2,5}\b/` 这种宽泛正则。

### 7.5 Deterministic Policy Layer

模型输出不是最终真理。`IntentResolver` 后续会通过 `intentPolicy.ts` 中的规则修正高风险误判。

policy layer 使用显式 rule model：

- `id`：稳定规则标识，例如 `subject.recall_cue_override`；
- `stage`：`normalize` / `guardrail` / `override` / `finalize`；
- `priority`：同组内优先级；
- `reasonCode`：稳定外部解释码；
- `reason`：标准化 `{code, category, severity}`；
- `applies(state)`：确定性 predicate；
- `apply(state)`：确定性 patch；
- `snapshot(state)`：before/after trace payload。

这样拆出来的原因是：intent policy 的影响面很大，一个优先级或分支顺序变化就可能影响
memory injection、clarification、agent routing 或 taskType。独立 rule model 让 reviewer
能分别检查 predicate、patch、priority、reason，而不是从长 resolver 分支里推断意图。

关键 guardrails 包括：

#### personal cue

如果请求含有明显个人上下文：

- “结合我”
- “适合我”
- “按我的”
- “for me”
- “based on my”

则 external 可升级为 mixed。

#### personal fact assertion

如果当前请求是短个人事实声明，例如：

- “Javis，我是David Liu”
- “我的名字是 David”
- “我喜欢用 TypeScript 写后端”
- “my name is David Liu”

则它不是对旧对话的召回，也不是对最近 topic 的 follow-up。policy 会把这类请求治理为：

- `subject=personal`；
- `taskType=chat`；
- `semanticEvidence.memoryRecall.target=none`；
- `needsMemory=false`；
- `referencesRecentHistory=false`；
- 有 recent history 时 `topicShifted=true`；
- `topic_analysis.current` 重建为当前 personal fact assertion，evidence 固定来自当前 prompt。

这样做的原因是：短个人事实声明通常会被小模型“吸附”到最近强上下文上，尤其当上一轮是
电商、投资、代码等内容丰富的话题时，模型容易把“我是 David Liu”解释成“继续某个业务构思”。
但这类输入本质上是在更新当前用户事实，不需要检索旧 memory；如果误判为 recall，会触发
不必要的 memory injection，并让 topic analysis 日志显示一个没有被当前 prompt 支撑的话题。

#### recall cue

如果明确问过去对话或 Jarvis 记忆：

- “我们之前聊过”
- “你上次说”
- “what did we discuss”

则可升级为 personal。

但这条被保护：

- `external_past_event` 不会因为“上次”被升级为 personal；
- `remember to save` 这类动作不是 memory recall。

#### low-confidence external

如果模型给了 external，但 subject confidence 低，则保守升级为 mixed。

原因：把需要用户上下文的请求误判成 external，会导致不注入记忆，损失更大。

#### action cue

如果用户明显要求执行：

- “帮我改”
- “运行测试”
- “实现”
- “提交”

则 taskType 可从 chat/analyze 修正为 execute。

#### schedule cue

如果用户明显要求提醒或周期任务：

- “提醒我”
- “每天”
- “每周”
- `remind me`
- `schedule`

则 taskType 可修正为 schedule。

#### delegate cue

只有显式 delegate/agent cue 才强推 delegation。

普通“分析 NVDA”可以添加 `investment-analysis` 到 candidateAgents，但不等于立即 delegate。

### 7.6 Multi-Intent 拆分与执行计划

Multi-Intent 现在不再只是“识别出多个 step 并注入 prompt”。当前实现分为三层。

第一层是 step 识别和拆分：

- 本地模型可以直接输出 `intent_steps`；
- resolver 会 normalize 每个 step 的 `id`、`type`、`action`、`target`、`dependsOn`、
  `requiresConfirmation`、`riskLevel`，并补齐 `operation`；
- `operation` 是每个 step 自己的 CRUD/lifecycle contract：

```ts
operation: {
  domain: RichIntentDomain;
  action: RichIntentAction;
  targetType: RichIntentTargetType;
  target: string;
  targetId?: string;
  selector?: string;
  scope?:
    | "current_session"
    | "long_term"
    | "workspace"
    | "external"
    | "scheduled_tasks"
    | "channel";
  riskLevel: "low" | "medium" | "high";
};
```

- 如果模型漏掉 steps，resolver 会根据 memory recall、personal context、external entity、
  action cue、delegate cue、schedule cue 做确定性补全；
- 对模型明确给出的 multi-step plan，Jarvis 保留原始顺序，只在 dependency 要求时做拓扑修正；
- 对确定性补全出来的 plan，Jarvis 使用默认顺序：`recall → analyze → delegate → execute → schedule`。

这样设计的原因是：用户表达的顺序本身可能有语义，例如“先提醒我，再分析”与“先分析，再提醒”
不是同一个执行计划。过去如果无条件按 step type 排序，会把模型或用户给出的执行顺序抹掉。
现在只有在模型没有给出可用 plan 时，才使用系统默认顺序。

`operation` 下沉到 `IntentStep` 的原因是：multi-intent 里不同 step 可以有不同动作。
例如“先总结历史，更新文档，再提醒我复盘”同时包含：

- `memory_management.recall.memory`;
- `code_modification.update.file`;
- `task_management.create.task`。

如果只保留全局 `richIntent.action`，后续只能知道“主动作”是什么，无法对每一步分别判断是否需要工具、
时间、目标、确认和风险控制。

第二层是 execution contract：

```ts
type IntentExecutionPlan = {
  mode: "single_llm" | "orchestrated";
  steps: Array<{
    step: IntentStep;
    mode: "context" | "llm" | "tool" | "agent" | "confirm";
    requiredTool: string | null;
    instruction: string;
    completionCriteria: string;
  }>;
  requiredTools: string[];
  completionCriteria: string[];
};
```

它把 `IntentStep` 从“语义描述”升级为“运行时契约”：

- `recall` step 通常是 `context` mode，优先使用已注入 memory/current context；
- `analyze` step 通常是 `llm` mode；
- `execute` step 在涉及 workspace/write/run 时是 `tool` mode；
- `schedule` step 通过 CRUD policy matrix 判断是 `task_add`、`task_update`、`task_delete` 还是 `task_list`；
- 创建类 schedule 缺时间时进入 `confirm` mode，删除类 schedule 不要求时间但要求目标；
- `delegate` step 在 agent target 明确时进入 `agent` mode，否则进入 `confirm` mode。

CRUD policy matrix 位于 `jarvis/src/memory-runtime/crudPolicy.ts`。它把每个 `operation`
映射成统一决策：

```ts
type CrudPolicyDecision = {
  ruleId: string;
  reasonCode: string;
  needsConfirmation: boolean;
  needsTime: boolean;
  needsTarget: boolean;
  defaultRiskLevel: "low" | "medium" | "high";
  requiredTool: string | null;
};
```

这样设计的原因是：如果 clarification、execution plan、tool routing 各自写一套判断，
规则会很快分叉。例如“删除提醒不应追问时间”这类问题，会在某个入口修好、另一个入口继续出错。
统一 matrix 后，规则优先级、reason code、测试矩阵和运行时行为可以对齐。

这样设计的原因是：只把 `<intent_plan>` 放进 system prompt，主模型仍可能漏掉某个工具步骤。
execution contract 明确告诉主模型“哪些 step 必须用工具完成、怎样才算完成、缺什么时应该阻塞”，
让 multi-intent 从提示升级为执行约束。

第三层是 required-tool enforcement：

- 主响应循环会记录本轮实际调用过的工具；
- 如果 execution plan 里存在可强制的 required tool，例如 `task_add`，但模型直接给了最终答案；
- Jarvis 会自动追加一轮 system follow-up，要求模型继续完成缺失的工具步骤；
- 最多重试固定次数，避免无限循环。

这样设计的原因是：Jarvis 不能只相信主模型会遵守计划。对于 schedule 这类有明确工具语义的
step，如果没有观察到 `task_add` 结果，就不能声称“已经提醒”。required-tool enforcement 把
“必须执行”从软提示变成运行时检查。

## 8. 第四层：模型选择

`LocalModelRouter` 使用 `complexityScore` 选择本轮主模型：

```ts
model = score >= threshold ? routing.targets.pro : routing.targets.flash;
```

配置位于：

```json
{
  "routing": {
    "enabled": true,
    "model": "gemma4:e2b",
    "threshold": 70,
    "targets": {
      "pro": "gemini-2.5-pro",
      "flash": "gemini-3.1-flash-lite"
    }
  }
}
```

这里有两个模型概念：

- `routing.model`：本地 Ollama intent 模型；
- `routing.targets.pro/flash`：真正回答用户的主 LLM，取值需要与当前主对话 backend 匹配。

如果本地 intent 模型失败，默认使用 `routing.targets.pro`。旧 `routing.proModel/flashModel`
仍作为 Gemini compatibility path 的兼容别名。

## 9. 第五层：Clarification Policy

`ClarificationPolicy` 位于 local routing 之后、memory injection 之前。

它的目标不是“低置信就问”，而是判断：

> 继续执行的风险是否高于追问成本。

### 9.1 输入

```ts
type ClarificationPolicyInput = {
  userPrompt: string;
  intent: IntentFrame | null;
  querySubject: QuerySubject;
  candidateAgents: string[];
  recentHistoryLength?: number;
};
```

### 9.2 输出

```ts
type ClarificationDecision = {
  shouldAsk: boolean;
  blocking: boolean;
  questions: AskUserQuestion[];
  reasons: string[];
};
```

当前版本只实现 blocking clarification。

也就是说：

- 需要追问时，先停下来；
- 有交互通道时等待用户回答；
- 没有通道时输出澄清问题并结束本轮；
- 用户回答后，把答案合并进 prompt，并重新跑一次 intent routing。

重新 routing 很关键，因为澄清答案可能改变：

- subject；
- taskType；
- memory target；
- action；
- time range；
- model selection。

### 9.3 触发条件

#### 高风险执行不明确

如果满足：

- `taskType` 是 `execute` / `delegate` / `schedule`；
- 或 `riskLevel=high`；
- 且 action 或 target 不明确；

则追问。

例：

> 帮我处理一下这个文件

Jarvis 不应猜“处理”是格式化、删除、提交还是运行测试。

#### delegate agent 不明确

如果：

- `taskType=delegate`；
- 多个 candidate agents 都合理；
- action confidence 不够高或 target 不明确；

则让用户选 agent。

#### schedule 时间不明确

如果：

- `taskType=schedule`；
- 没有 `resolvedDateRange`；
- 也没有 `timeWindowDays`；

则追问具体时间。

#### memory target 不明确

如果：

- `querySubject` 不是 external；
- `needsMemory=true`；
- `memoryTarget` 置信度低或 ambiguity 指向 memory/context；

则追问：

- 当前对话；
- 长期记忆；
- 都不需要。

#### 当前上下文指代缺失

如果：

- `referencesRecentHistory=true`；
- `memoryRecall.target=current_context_reference`；
- 但近期 history 为空；

则追问用户“这个/刚才/继续”具体指什么。

### 9.4 可观测性开关

配置：

```json
{
  "routing": {
    "clarificationObservability": true
  }
}
```

开启后会输出结构化 trace：

```text
[clarification] {"enabled":true,"shouldAsk":false,...}
```

包含：

- shouldAsk / blocking；
- reasons；
- questionHeaders；
- intent subject/taskType/confidence；
- confidenceByDimension；
- memoryTarget；
- riskLevel；
- ambiguity；
- input querySubject/candidateAgents/recentHistoryLength。

默认值是 `false`，避免日志过多。

## 10. 第六层：Topic Shift

clarification 之后，Jarvis 才处理 topic shift。

原因：

- 如果需要追问，不能先清空 history；
- 用户回答澄清问题后会重新 route，topic shift 应基于最新 result 判断。

当前逻辑：

- `result.topicShifted=true`
- 当前不是第一轮；
- `routing.topicShiftDetection !== false`

则清空当前 chat history。

但如果用户是“继续”“这个”“刚才那个”等当前上下文引用，guardrails 会把 `topicShifted` 强制为 false。

### 10.1 Grounded Topic Analysis

Topic analysis 已从简单的：

```json
{
  "history_topic": "Procurement Agent architecture",
  "new_topic": "LLM reliability and Agent decision-making"
}
```

升级为 evidence-grounded 结构：

```json
{
  "topic_analysis": {
    "history": {
      "label": "AI Agent in Procurement",
      "evidence": ["AI Agent在企业采购流程中的优势与必要性？"],
      "source_turns": [-2],
      "confidence": 0.95
    },
    "current": {
      "label": "LLM Reliability and Agent Decision-Making",
      "evidence": ["LLM可靠性对Agent决策有什么影响？"],
      "source_turns": [0],
      "confidence": 0.95
    },
    "relation": "new_topic",
    "relation_reason": "same broad AI-agent domain, but different focus",
    "confidence": 0.95
  }
}
```

这解决的是 topic label 漂移问题：模型不能只自由生成一个话题名，还要给出支撑它的证据。

代码层还有几个通用保护：

- `referencesRecentHistory=true` 时，`relation` 强制为 `current_context_reference`；
- 没有 relation 但有 recent history 时，默认回退到 `adjacent_topic`，避免不可解释的 unknown；
- 如果 evidence 缺失，会用当前 prompt 或对应 history turn 作为 grounding fallback；
- `lowGrounding=true` 会降低 `topicShift` 维度置信度，提醒后续策略保守处理。
- 对短个人事实声明，topic analysis 不信任模型继承的 history topic，而是强制重建 current label
  与 evidence，避免出现 `new="电商领域AI工具构思"` 但 evidence 只有“我是David Liu”的日志错配。

## 11. 第七层：Intent-Aware Memory Policy

`refreshContext()` 会先调用 `buildIntentAwareMemoryPolicy()`。

这一步决定三类记忆是否允许进入本轮上下文：

- facts；
- summary；
- prewarm vector memories。

### 11.1 输出

```ts
type IntentAwareMemoryPolicy = {
  querySubject: QuerySubject;
  allowFacts: boolean;
  allowSummary: boolean;
  allowPrewarm: boolean;
  factQuery: string;
  prewarmQuery: string;
  shouldRewritePrewarmQuery: boolean;
  prewarmLimit: number;
  prewarmMaxDistance: number;
  reasons: string[];
};
```

### 11.2 默认逻辑

如果没有 `IntentFrame`，退回旧逻辑：

- `external` 不注入；
- `personal/mixed` 注入。

如果有 `IntentFrame`，以 `intent.needsMemory` 为基础。

### 11.3 强约束

#### `external`

纯 external 请求默认不注入个人 facts、summary、prewarm memories。

例：

> 太阳系有哪些行星？

不需要用户记忆。

#### `external_past_event`

例：

> 上次苹果发布会发布了什么？

这是外部历史事件，不是“我们上次聊过什么”。因此：

- 不查 facts；
- 不查 summary；
- 不查 prewarm memories。

#### `current_context_reference`

例：

> 继续这个方案

这是当前上下文引用，不急着查长期记忆。因此：

- 不查 facts；
- 不查 summary；
- 不查 prewarm memories；
- 主要依赖 chat history。

#### tool task without memory dependency

如果是 execute/delegate/schedule，且 `richIntent.contextDependency.longTermMemory=false`，则不注入长期记忆。

例：

> 运行当前测试

不应注入用户偏好或历史对话。

#### 低置信 memory/subject

如果 `subject` 或 `memoryTarget` 置信度低：

- 禁用 summary；
- 禁用 prewarm；
- facts 仍可在 `needsMemory=true` 时保留。

这是为了减少语义检索带来的上下文污染。

### 11.4 查询构造

`prewarmQuery` 会把以下信息合并：

- 原始用户输入；
- `richIntent.targets`;
- entity hints。

这样像 “结合我的风险偏好分析 NVDA” 会把 `NVDA` 作为检索线索保留下来。

`factQuery` 在 personal/mixed 时会加前缀：

```text
PRIVATE_USER_DATA: User Query - ...
```

这是为了让 fact retrieval 更偏向用户私有事实。

## 12. 第八层：上下文检索

`refreshContext()` 继续执行实际检索。

### 12.1 Facts

当 `memoryPolicy.allowFacts=true`：

```ts
memoryService.searchFacts(memoryPolicy.factQuery);
```

返回结构化长期事实，例如偏好、身份、项目设定等。

### 12.2 Skills

如果可用 skills 数量超过配置上限：

- 优先走 `memoryService.searchSkills(userPrompt, limit, maxDistance)`；
- 如果 skill index 正在构建，回退注入完整 skill list；
- 如果没有相关 skill，注入空列表。

这一层和 intent memory policy 相对独立，主要控制技能说明是否进入 system prompt。

### 12.3 Prewarm Memories

当 `memoryPolicy.allowPrewarm=true`：

1. 取 `memoryPolicy.prewarmQuery`；
2. 如果 `routing.queryRewrite=true` 且 policy 允许，则调用本地模型重写 memory query；
3. 调用 `memoryService.searchWithScore()`；
4. 按 score/margin/reranker 规则过滤；
5. 产出 `PrewarmCandidate[]`。

非 reranker 模式下还有 top-1 信心保护：

- top1 score 太低：不注入；
- top1 和 top2 margin 太小：只注入 top1。

reranker 开启时，使用 `reranker.memoryRelevanceThreshold` 过滤。

### 12.4 Summary Chunks

当 `memoryPolicy.allowSummary=true` 且存在 `conversationSummary`：

1. 先查 summary chunk vector index；
2. 如果查不到，再用 fallback 从全文 summary 中抽相关段落。

`current_context_reference` 和 `external_past_event` 会禁用 summary 注入。

## 13. 第九层：MemoryInjectionPlanner

检索到候选项后，不会直接全部塞进 prompt，而是交给 `MemoryInjectionPlanner`。

它控制：

- 总字符预算；
- facts 字符预算；
- summary 字符预算；
- prewarm 字符预算；
- 单条 item 最大长度；
- personal/mixed 下不同 item 数量限制。

### 13.1 external 二次保护

如果 `querySubject=external`，planner 会拒绝所有：

- facts；
- summary；
- prewarm memories。

这是一道二次保险。即使前面 policy 某处失误，planner 仍能避免 external 请求注入个人记忆。

### 13.2 mixed 更保守

mixed 查询比 personal 更容易污染上下文，因此：

- fact items 更少；
- summary items 更少；
- prewarm items 更少；
- prewarm distance 更严格。

### 13.3 输出

```ts
type MemoryInjectionPlan = {
  facts: FactCandidate[];
  relevantSummarySection: string;
  prewarmSection: string;
  factsInjected: number;
  summaryInjected: number;
  prewarmInjected: number;
  usedChars: number;
  rejected: MemoryInjectionRejectedItem[];
};
```

最终 `refreshContext()` 用它重建 system prompt：

```text
Jarvis preamble
+ facts protocol
+ relevant summary section
+ prewarm section
```

## 14. 第十层：主 LLM 响应循环

系统 prompt 刷新后，Jarvis 调用：

```ts
client.sendMessageStream(currentQueryParts, abortSignal, promptId);
```

主 LLM 会流式返回：

- `Content`；
- `ToolCallRequest`；
- `Error`；
- `ModelInfo`。

Jarvis 会：

- 把 content 实时 emit 给 UI/channel；
- 收集 tool calls；
- 过滤 `ModelInfo`，避免模型名出现在聊天输出；
- 遇到 tool calls 时进入工具执行循环。

### 14.1 工具循环保护

有两类安全限制：

- `maxToolIterations`：防止无限工具循环；
- `maxConsecutiveToolFailures`：防止连续失败还继续重试。

网络错误则按 `network.maxRetries` 指数退避重试。

如果所有网络重试失败，可按配置清理 orphaned user turn。

## 15. 第十一层：ToolRouter

工具调用由 `ToolRouter.route()` 处理。

它把工具分成两类：

- Jarvis native tools；
- Gemini/Scheduler 标准工具。

### 15.1 Jarvis native tools

当前 native tools 包括：

- `save_memory`
- `recall_memory`
- `ask_user`
- `push_to_channel`
- `task_*`
- `read_file`
- `write_file`
- `read_many_files`
- `glob`
- `grep`
- `run_shell_command`
- `run_evolved_skill_*`

#### save_memory

保存用户明确要求记住的信息。

重要性计算是确定性的 two-factor：

- category base score；
- remember intent score。

它不使用 distiller 的 LLM score，因为 tool call 本身缺少完整内容分析信号。

#### recall_memory

主动查询长期记忆。

它会使用 router 推断出的时间窗口作为 fallback：

- 如果 LLM 没传 `time_window_days`，用 `currentTimeWindowDays`；
- 如果 LLM 没传 `date_from/date_to`，用 `currentDateRange`；
- 如果 query 为空，从当前 user prompt 派生关键词。

这让“昨天我们讨论了什么”这类请求能正确约束时间范围。

#### ask_user

这是主 LLM 工具层的追问能力，和 clarification policy 的前置追问不同。

区别：

- ClarificationPolicy：LLM 响应前，基于 IntentFrame 做前置追问；
- ask_user tool：主 LLM 在执行过程中主动调用工具追问。

如果有 WebSocket handler，则等待用户输入；否则会 auto-select recommended options。

#### task\_\*

交给 `TaskCommandHandler`，用于任务增删改查和触发。

#### push_to_channel

通过 `ChannelRegistry` 推送到 Feishu/WeChat 等渠道。

#### workspace tools

`read_file`、`write_file`、`read_many_files`、`glob`、`grep` 和 `run_shell_command`
是 Jarvis-native workspace tools，不再依赖 Gemini CLI scheduler。

这些工具的作用是让 OpenAI-compatible standalone runtime 也具备基础 workspace 操作能力。
所有路径都会被限制在当前 workspace root 内；读文件会阻断常见敏感文件；shell 命令会阻断
明显危险的系统/破坏性命令，并有 timeout 与输出截断。

这样设计的原因是：workspace 操作是 agent 执行层的核心能力，如果继续只依赖 Gemini CLI
内置工具，那么更换 LLM backend 时会失去文件读写、搜索和命令执行能力。把这些能力移到
Jarvis-native runtime 后，Gemini 和 OpenAI-compatible backend 都可以消费同一套 tool
contract。

### 15.2 标准工具

非 native tools 在 Gemini compatibility path 中交给 Gemini scheduler；standalone path
中未注册的工具会返回明确失败结果。

特殊逻辑：

如果工具是 `generalist` 或 `codebase_investigator`，Jarvis 会给 request 额外注入：

- `searchFacts(query)`；
- `search(query, 3)`。

这是 subagent memory injection，目前还不完全受 P3 的 intent-aware memory policy 控制，需要后续继续收敛。

## 16. 第十二层：响应结束后的异步善后

主循环结束后，如果本轮不是纯 task tools，Jarvis 会异步做三件事。

### 16.1 会话记忆入队

```ts
memoryService.enqueue(sessionId, userPrompt, finalAssistantText);
```

用于后续向量记忆、会话记录等。

### 16.2 BackgroundDistiller

如果启用 distiller，会从用户输入和助手输出中提炼持久事实。

它重点避免把助手自己编出来的内容当成用户事实。

### 16.3 history compression

如果内存中的 chat history 超过阈值，会压缩为 summary，并只保留最近若干 raw turns。

压缩后的 summary 也会进入 summary chunk index，供后续 memory policy 允许时检索。

## 17. 关键场景决策表

| 用户请求                    | subject                 | taskType     | memory target             | 主要行为                                                |
| --------------------------- | ----------------------- | ------------ | ------------------------- | ------------------------------------------------------- |
| `太阳系有哪些行星`          | external                | chat/analyze | none                      | 不注入个人记忆，直接回答                                |
| `上次苹果发布会发布了什么`  | external                | analyze      | external_past_event       | 不注入个人记忆，避免误当 personal recall                |
| `我们之前聊过 ONNX 部署吗`  | personal                | recall       | conversation_history      | 允许记忆检索，并可用时间窗口                            |
| `你记得保存这个文件吗`      | external/mixed 视上下文 | execute/chat | none                      | 不因“记得”触发 memory recall                            |
| `继续刚才那个方案`          | personal                | chat/execute | current_context_reference | 不查长期记忆，依赖当前 history                          |
| `结合我的风险偏好分析 NVDA` | mixed                   | analyze      | user_memory/none          | 注入受限个人上下文和外部实体线索                        |
| `分析 ONNX 的基本面`        | external                | analyze      | none                      | ONNX 作为技术词，不自动添加投资 agent                   |
| `分析 NVDA 的基本面`        | external/mixed          | analyze      | none/user_memory          | 可添加 investment-analysis candidate，但不强制 delegate |
| `帮我处理一下这个文件`      | external/mixed          | execute      | none/current_context      | 高风险且动作不清，先追问                                |
| `提醒我复盘投资组合`        | mixed/external          | schedule     | none/user_memory          | 没有明确时间则先追问                                    |

## 18. 当前设计的边界

### 18.1 IntentFrame 是决策输入，不是最终答案

IntentFrame 只决定路由、追问、上下文注入、工具 fallback 参数。最终回答仍由主 LLM 生成。

### 18.2 规则不是为了替代 LLM

deterministic guardrails 只处理高频、高风险、可明确编码的失败模式。

例如：

- “上次发布会”不是 personal recall；
- “remember to save” 不是 memory recall；
- 技术缩写不是股票 ticker；
- 执行动作不明确时先追问。

LLM 负责开放语义理解，代码负责安全边界和一致性。

### 18.3 ClarificationPolicy 当前是 blocking-only

当前版本只支持前置阻塞式追问。

还没有实现：

- 多轮 clarification state machine；
- non-blocking advisory clarification；
- 自动提出默认方案并让用户确认。

### 18.4 Subagent memory injection 仍需收敛

`ToolRouter` 里对 `generalist` / `codebase_investigator` 的 memory injection 仍是工具层独立逻辑。

它还没有完全复用 `IntentAwareMemoryPolicy`，后续可以把 subagent request 也纳入同一套 policy。

### 18.5 外部知识仍依赖主模型或工具能力

`needsExternalKnowledge=true` 目前主要影响 intent 表达和后续规划，不等于一定会自动搜索互联网。

是否搜索外部世界仍取决于主模型工具调用和运行环境能力。

## 19. 如何调试一次意图理解

建议按以下顺序看日志。

### 19.1 Local routing 日志

```text
🔀 [Jarvis] Local routing: ...
```

关注：

- selected model；
- subject；
- topic_shifted；
- time_window；
- classifier reason；
- source。

### 19.2 Clarification trace

开启：

```json
{
  "routing": {
    "clarificationObservability": true
  }
}
```

查看：

```text
[clarification] {...}
```

关注：

- `shouldAsk`;
- `reasons`;
- `confidenceByDimension`;
- `ambiguity`;
- `memoryTarget`;
- `riskLevel`。

### 19.3 Intent-aware memory policy 日志

```text
🔍 [Jarvis] Intent-aware memory policy — skipping facts (...)
🧠 [prewarm] disabled by intent-aware policy (...)
🧠 [summary] disabled by intent-aware policy (...)
```

关注：

- 是否因为 external/current_context/external_past_event 禁用了记忆；
- mixed 是否使用更严格的 limit/distance；
- low confidence 是否禁用了 summary/prewarm。

### 19.4 MemoryInjectionPlanner 日志

```text
🧠 [MemoryInjectionPlanner] candidates(...) → injected(...)
```

关注：

- 候选数量；
- 实际注入数量；
- rejected reason；
- used chars。

### 19.5 ToolRouter 日志

```text
🧠 [Jarvis] Active Recall initiated ...
❓ [Jarvis] ask_user ...
📅 [Jarvis] Task tool invoked ...
```

关注：

- recall_memory 是否使用了 router fallback 时间范围；
- ask_user 是前置 clarification 还是 LLM 工具中途追问；
- task tools 是否导致跳过 memory distill。

## 20. 当前距离工业级的具体差距

如果用“能不能稳定支撑真实长期使用、模型切换、复杂请求和持续演进”这个标准来看，
Jarvis 当前的 intent-understanding 层已经完成了一批关键工程化补强，但离工业级仍有一些
明确差距。下面按维度区分“已完成/部分完成/仍需加强”。

### 20.1 输出稳定性还不够

状态：部分完成。

当前最明显的问题不是“完全不会判断”，而是“判断结果偶尔不稳定”：

已完成：

- 已经有 JSON parse / repair / deterministic fallback；
- 已经把复杂 schema 拆出 focused extractors，例如 memory target 和 entity hints；
- 已经通过 policy layer 对高风险误判做确定性修正；
- 已经把非法 JSON、repair、fallback、policy trace 纳入可观测日志。

仍需加强：

- 本地小模型仍可能输出非法 JSON，需要 repair 才能继续；
- repair 本身不是 100% 成功，因此 fallback 仍是必要兜底；
- 同一个 case 多次运行，topic relation、topic grounding、candidate agents 仍可能波动；
- 小模型在 schema 变长后仍容易掉字段、偷懒泛化、用抽象句子代替 grounded evidence。

这说明当前系统已经具备纠错能力，但还没有达到“输出天然稳定、错误率足够低”的工业级状态。

### 20.2 语义表达仍偏薄

状态：部分完成。

已完成：

- 已经引入 `richIntent`、`confidenceByDimension`、`intentSteps`；
- `intentSteps` 已不再只服务 prompt 注入，已经进入 `IntentExecutionPlan` 和运行时 enforcement；
- 已经能表达 recall / analyze / execute / delegate / schedule 等多步骤任务；
- clarification 和 memory policy 已开始消费 step 信息。

仍需加强：

- step 的 `action` 和 `target` 仍然比较粗，很多时候是 fallback 文本，而不是精确参数；
- 缺少更强的 argument extraction，例如 reminder time、output format、deliverable path、
  comparison set、约束条件、成功标准；
- 当前 schema 仍偏向单轮理解，还没有把“用户期望的最终产物”表达得足够清楚；
- 对文件路径、工具参数、交付物格式这类可执行参数，还没有统一参数 schema。

工业级系统通常不只知道“这是 recall + analyze + schedule”，还要知道“分析什么、产出什么格式、提醒在什么时间、缺什么参数、哪些步骤必须确认”。

### 20.3 Multi-Intent 已进入执行层，但还不是完整 orchestrator

状态：部分完成，且相比早期差距已经明显收敛。

这块已经从“阶段一识别”推进到“执行契约”：

- 已经能识别并暴露多步骤意图；
- 已经保留模型/用户给出的 step 顺序，并按 dependency 做规范化；
- 已经生成 `IntentExecutionPlan`；
- 已经注入 `<intent_execution_contract>`；
- 已经对 `task_add` 等可强制 required tool 做运行时 enforcement；
- clarification 和 memory policy 已开始按 step 粒度消费。

但它还不是完整 orchestrator：

- `analyze`、`execute`、`delegate` 的很多行为仍由主 LLM 和工具可用性共同完成；
- `delegate` step 目前更多是 execution contract 和 agent target 约束，还没有统一自动启动所有 candidate agent；
- `execute` step 只能强约束已知 required tool，不能保证所有 workspace 操作都被静态验证；
- step 级状态还没有持久化为可恢复的 runtime state machine。

因此当前状态是：Multi-Intent 已经具备识别、拆分、执行契约和部分 runtime enforcement，但还没有升级为完全独立的 step orchestrator。

### 20.4 Topic understanding 仍然受模型表述噪声影响

状态：部分完成。

Topic grounding 已经比之前稳定，但仍有现实问题：

- 已经增加 grounded topic analysis，要求 history/current label 必须有 evidence；
- 已经修正 `referencesRecentHistory=false` 与 `topicAnalysis.relation=current_context_reference`
  的一部分冲突；
- 已经为短个人事实声明增加 topic 重建 guardrail，避免“我是 David Liu”被吸附到上一轮电商话题；
- 已经增加 topic grounding eval case。

仍需加强：

- 模型仍可能把普通新问题误判成 `current_context_reference`；
- 模型仍可能给出抽象总结，而不是来自原文的 grounded evidence；
- `referencesRecentHistory=false` 与 `topicAnalysis.relation=current_context_reference`
  这种语义冲突仍可能出现，需要继续靠 policy 修正；
- topic label 与 evidence 的一致性目前主要通过局部 guardrail 和 eval 约束，还不是完整的语义校验器。

工业级 topic inference 要求 relation、history topic、current topic、evidence 之间高度一致，不能靠日志里人工解释。

### 20.5 Recall / personal / mixed 的边界仍然脆弱

状态：部分完成。

这部分已经比最初稳很多，但仍不是彻底解决：

已完成：

- 已经修复“记得保存这个文件吗”这类 remember-to-action 假阳性；
- 已经修复“上次苹果发布会”这类 external past event 被误升 personal recall 的问题；
- 已经修复短个人事实声明，例如“Javis，我是David Liu”被误判为 recall / topic follow-up；
- 已经通过 reason-coded policy trace 固化 recallCue、personalCue、external entity 等优先级；
- 已经增加相关 unit test 和真实模型 eval case。

仍需加强：

- “记得”“之前”“上次”这类自然语言在中文里仍高度多义，长尾假阳性不可避免；
- 同一句话既可能是“问我的偏好”，也可能是“结合我的偏好分析外部对象”，语义边界很细；
- 当前很多正确结果仍来自 policy 组合，而不是模型本身天然稳定地区分；
- policy 已系统化，但长尾 case 增长后仍需要更强的语义分类和 eval 自动回灌来控制维护成本。

工业级系统可以接受 policy，但不能长期依赖不断叠加 case-by-case 规则，否则维护成本会持续上升。

### 20.6 评测覆盖仍不足以证明工业级

状态：部分完成。

已完成：

- 已经有真实模型 eval；
- 已经有 `smoke` / `core` / `extended` / `stress` 分层 suite；
- 已经有 topic grounding、personal fact、multi-intent、proactive clarification 等回归 case；
- 已经具备失败样本 candidate 输出；
- 已经有 policy trace reason code 和部分 baseline 能力；
- eval runner 已支持 clarification execution context，能覆盖 proactive task 这类非交互场景。
- eval runner 已支持 `--repeat` 一致性检查、`--max-inconsistency-rate` 门禁和跨模型差异报告。

仍需加强：

- 当前 case 数量还不够大，覆盖的业务面有限；
- 还缺少大规模真实 query 回放、按分布采样和线上日志自动回灌；
- 还没有稳定的跨模型回归基线、分版本趋势追踪、失败聚类分析；
- 波动性已经能通过 repeated eval 测量，但还没有进入 nightly trend；
- 当前 eval 更偏功能回归，还不是完整质量运营体系。

工业级不是“这一轮通过”，而是长期、跨模型、跨版本、跨分布地稳定通过。

### 20.7 与下游模块的契约还不够硬

状态：部分完成。

当前 intent layer 已经开始影响 memory injection、clarification、agent routing，但耦合还不够深：

已完成：

- memory policy 已开始识别 recall step；
- clarification policy 已开始按 `intentSteps` 和 step risk 驱动；
- proactive task 已能通过 `executionContext=proactive_task` 影响 clarification 行为；
- `IntentExecutionPlan` 已开始约束 required tool，例如 schedule step 对 `task_add` 的 enforcement；
- memory injection planner 已基于 intent-aware policy 做最终过滤。

仍需加强：

- memory policy 还没有对每个 step 独立生成 memory scope；
- clarification policy 已有 step 粒度，但还不是完整多轮 state machine；
- agent routing 仍然部分依赖 candidate heuristic，而不是完整 execution plan；
- 执行失败后的反馈还不会反向修正 intent understanding；
- tool/subagent 层还没有完全统一消费同一份 memory / execution contract。

工业级系统通常要求 intent layer 成为统一语义入口，下游模块消费同一份 contract，而不是每层都再做一次自己的轻量理解。

### 20.8 观测与运营能力还偏初级

状态：部分完成。

已完成：

- 已经有可开关的 clarification observability；
- 已经有 `policyTrace`，每条 deterministic rule 有 reason code / category / severity；
- eval 报告已经按 dimension、tag、policy reason code 汇总；
- 已经开始记录 JSON repair、fallback、focused extractor、topic analysis、memory policy 等关键日志。

仍需加强：

- 没有统一 dashboard 看 subject/taskType/memoryTarget 的错误率走势；
- 还没有按模型、场景、语言、query length 建立长期质量统计；
- 没有完整 failure taxonomy 和 root-cause 标注体系；
- 还没有把 repair rate、fallback rate、topic conflict rate 作为健康指标长期监控。

工业级 intent system 必须既能做对，也能看见自己什么时候没做对。

## 21. 后续演进路线

### 21.1 P0：扩大真实模型 Intent Eval

最高优先级仍然是扩大 intent evaluation harness，而且要跑真实 Ollama 模型，不只验证 mock 结果。

评测数据集应继续覆盖：

- 个人记忆召回 vs 外部历史事件；
- 当前会话指代 vs 长期记忆召回；
- `chat` vs `analyze` vs `execute`；
- 明确 delegation vs candidate agent 推荐；
- schedule/reminder；
- 金融 ticker vs 技术缩写；
- mixed 和多步骤请求。

指标应该按维度统计，而不是只给整体 pass/fail。这样可以看出某个模型到底是弱在 memory recall、entity typing、delegation，还是 action detection。

### 21.2 P1：让 `IntentFrame` 成为更硬的执行契约

当前 `IntentFrame` 仍保留兼容字段 `subject` 和 `taskType`，但强意图理解系统需要更明确表达用户到底想完成什么：

- user goal；
- primary action；
- targets；
- context dependency；
- ambiguity；
- risk level；
- success criteria；
- output constraints。

这不是为了让 schema 更复杂，而是为了让 clarification、memory、tool、agent 不再各自重做轻量理解。

### 21.3 P1：Multi-Intent / IntentSteps 进入完整 orchestrator

当前 Multi-Intent 已经完成识别、拆分、execution contract 和部分 required-tool enforcement。
下一步是把它升级成完整 orchestrator：

- 每个 step 有显式 state：`pending` / `running` / `completed` / `blocked` / `failed`；
- 每个 step 的 tool call、agent task、memory retrieval 都能被记录和恢复；
- dependent step 只有在 dependency completed 后才运行；
- `delegate` step 可按 agent target 自动启动，并把结果回填给后续 step；
- `execute` step 的 workspace/file/tool side effect 能被验证；
- final response 基于 step 状态生成，而不是只依赖主 LLM 自述。

长期可以引入：

```ts
type ExecutionPlan = {
  steps: IntentStep[];
  mode: "single_llm" | "orchestrated";
};
```

当前短期实现仍以主 LLM 为执行中心，但已经有 execution contract 和 required-tool enforcement。
长期目标是 Jarvis 自己按 step 主动调 retrieval、file write、schedule tool 或 subagent。

### 21.4 P1：Clarification state machine

ClarificationPolicy 当前是 blocking-only。下一步需要把它变成状态机：

- 记录已问过的问题；
- 记录用户回答映射到哪个 intent field；
- 支持多轮补参；
- 支持默认方案确认；
- 支持执行前确认和执行后纠偏；
- 避免重复追问同一个字段。

这样做的原因是：执行、调度、delegate、memory 边界都可能需要补参。如果 clarification 只是一次性判断，很难支撑可靠 agent。

### 21.5 P1：统一 Memory Policy 到 subagent/tool 层

当前主路径的 memory injection 已经 intent-aware，但 subagent/tool 层仍有独立 memory 注入逻辑。

后续应把 tool/subagent request 也纳入同一套 policy：

- external 请求不能在 subagent 层泄漏 personal memory；
- mixed 请求要按 step 和 target 注入；
- tool 层 recall fallback 要继承 router 的 time range 和 memory target；
- subagent prompt 应显式携带 memory policy decision，而不是自己再猜。

### 21.6 P2：模型稳定性治理

需要继续评估不同本地模型：

- `gemma4:e2b`
- `gemma4:e4b`
- `qwen3:0.6b`
- 更大 qwen / gemma 模型

评估维度不只是 pass rate，还包括：

- JSON repair rate；
- latency；
- fallback rate；
- confidence calibration；
- policy reason distribution；
- 同 case 多次运行的一致性。

### 21.7 P2：Confidence calibration 落到 runtime 阈值

当前 calibration 已经能生成报告，但 runtime 阈值还没有自动引用 calibration 结果。

后续可以让阈值配置来自 eval 统计：

- 对不同 confidence dimension 使用不同 floor；
- 对不同 model 使用不同 floor；
- 对高风险 task 使用更高 floor；
- 对低风险 chat 使用更低 floor；
- 阈值调整必须通过 regression gate。

### 21.8 P3：线上反馈闭环自动化

当前 eval failure 可以生成 candidates；真实使用中的高价值 intent 样本也可以通过
`intentFeedback.enabled=true` 进入 runtime candidate queue。

当前 runtime collector 已支持的信号：

- router fallback；
- deterministic parse fallback；
- warning / critical policy correction；
- low-confidence dimension；
- topic low-grounding；
- clarification requested / blocking / blocked_without_channel。

输出位置：

```text
~/.gemini-jarvis/intent-feedback/runtime-intent-candidates-latest.jsonl
```

后续还可以继续接入更强的用户反馈信号：

- 用户反馈“这不对”；
- clarification 后仍失败；
- tool execution 因 intent 参数不完整失败；
- memory injection 明显错注入；
- policy trace 出现 critical correction 但最终用户不满意。

这些样本不应直接进入正式 eval，而应进入 candidate queue，经过人工审核后补 expected，再进入 regression cases。

## 22. 一句话总结

当前 Jarvis 的意图理解层已经不是“让 LLM 自己看着办”，而是一个分层治理系统：

1. 本地模型输出结构化 `IntentFrame`；
2. schema validation / repair 控制模型输出可信边界；
3. deterministic policy layer 修正高风险误判并输出 trace；
4. clarification / memory policy 把 intent 变成可执行决策；
5. eval / calibration / feedback loop 把质量治理变成可回归系统；
6. 主 LLM 在被约束过的上下文和工具环境里完成最终响应。

这个架构的关键价值是：LLM 负责语义弹性，代码负责可解释性、一致性和安全边界。
