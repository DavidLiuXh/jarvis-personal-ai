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

## 分层设计原则

Jarvis 的 intent understanding 现在被拆成多个相对独立的层级。这样做不只是为了代码
整洁，而是为了把“概率判断”和“确定性治理”分开，让每层承担不同责任。

### 1. 本地模型层：负责语义判断

用途：

- 从用户输入和近期 history 中提取 `IntentFrame`；
- 判断 subject、taskType、memoryTarget、topic relation；
- 输出 rich intent、entity hints、intent steps 和 confidence。

原因：

- 这些判断依赖自然语言理解，不能靠关键词完整覆盖；
- 中文里的“之前”“记得”“上次”“帮我处理一下”高度多义，模型比规则更适合给出初始语义解释；
- 将模型限制在“产生结构化语义证据”，而不是直接决定所有下游行为，可以降低模型误判的破坏范围；
- 本地模型可替换，后续可以通过 eval 对比 `gemma`、`qwen` 等模型，而不需要重写下游逻辑。

### 2. Schema validation / repair 层：负责输入可信度边界

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

### 3. Policy layer：负责确定性语义治理

用途：

- 对模型输出执行稳定的 guardrail、override、finalize；
- 统一处理 recall/personal/mixed、external past event、ticker false positive、delegate false positive 等边界；
- 输出 `policyTrace`，记录每次修正的 rule、reason、before/after。

原因：

- 模型输出是概率性的，但 memory injection、tool execution、agent routing 需要可预测行为；
- 一些错误的代价不对称，例如把 external 问题误判为 personal 会污染上下文，把 execute 误判为 chat 会漏执行；
- 如果 guardrail 分散在 resolver 各处，优先级、覆盖率和回归路径都会变得不可控；
- 独立 policy layer 让每条规则都有 id、priority、reason 和测试 case，便于 code review 和 eval 回归。

### 4. Eval / calibration 层：负责质量度量

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

### 5. Feedback loop 层：负责把真实失败变成资产

用途：

- 把 eval 失败输出成 JSONL candidate；
- 保留 prompt、history、failed checks、observed intent、clarification decision；
- 让失败样本经过人工审核后进入正式 regression case。

原因：

- 真实用户失败通常比预设测试更能暴露系统边界；
- 如果失败只停留在日志里，后续修改很容易再次引入同类问题；
- candidate 格式把“发现问题”到“补充 eval”之间的成本降下来；
- 长期看，feedback loop 是 intent system 从项目功能走向运营系统的关键。

## 最近一次架构调整：Policy Trace、置信度校准与失败样本闭环

最近这轮改动的核心目标不是继续增加零散 guardrail，而是把 intent understanding
里的确定性修正规则，升级成可解释、可回归、可运营的 policy layer。

这次调整可以理解为三层：

1. **Policy trace 标准化**

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

   这意味着一次 subject/taskType/memoryTarget 的修正，不再只是日志里的一句话，而是
   一个可被测试、可被聚合、可被基线比较的结构化事件。

   这样设计的原因是：`reasonCode` 适合单点调试，但不适合长期运营。工业级系统需要
   回答“最近 subject boundary 的 critical 修正规则是否变多了”“某个模型是否更容易触发
   agent routing 修正”“某次改动是否改变了 policy path”。这些问题都要求 reason 既稳定
   又可聚合。

2. **Confidence calibration**

   eval runner 现在会按 confidence dimension 聚合真实模型输出：
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
   阈值治理”。当 eval 样本足够多时，我们可以基于真实 pass/fail 分布调整
   `LOW_CONFIDENCE_THRESHOLD`、clarification threshold、entity confidence threshold
   等关键阈值，而不是凭感觉调参数。

   这样设计的原因是：confidence 本身不是事实，它只是模型对自己判断的估计。如果不把
   confidence 和实际 pass/fail 关联起来，阈值就是经验常量。calibration 层把 confidence
   变成可校准信号，使后续阈值调整有数据依据。

3. **线上反馈闭环**

   eval runner 新增失败样本沉淀能力。任何 eval 失败都可以输出成 JSONL candidate：

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

   这样设计的原因是：intent system 的真实难点来自长尾表达。人工预设 case 永远不可能
   覆盖所有长尾，必须让真实失败样本进入测试资产。candidate 不是直接变成测试，因为
   observed output 不等于 expected truth，中间需要人工审核；但它把回灌路径标准化了。

### 本次实现边界

这轮已经完成：

- policy registry 校验 reason metadata；
- `IntentFrame.policyTrace` 输出标准化 reason；
- policy trace baseline 升级到 v2，并比较 `reason.category` / `reason.severity`；
- eval markdown/json 报告展示 policy reason code 的 category 和 severity；
- eval 报告生成 confidence calibration 表；
- eval 失败时生成 JSONL candidate；
- 单元测试覆盖 policy reason metadata 和 trace 输出；
- 使用 `gemma4:e2b` 跑通 core baseline、baseline compare、full eval 和失败样本 smoke test。

这轮尚未完成：

- runtime 阈值还没有自动读取 calibration 结果；
- 线上真实日志还没有自动接入 candidate 生成流程；
- 还没有 dashboard 展示长期趋势；
- 还没有对不同模型建立长期稳定性曲线。

因此当前状态是：policy layer 已经具备工业级治理骨架，但 confidence 和 feedback loop
仍处于“可生产数据、可人工闭环”的阶段，还没有完全自动化运营。

## 当前距离工业级的具体差距

如果用“能不能稳定支撑真实长期使用、模型切换、复杂请求和持续演进”这个标准来看，
Jarvis 当前的 intent-understanding 层离工业级还有这些明确差距：

### 1. 输出稳定性还不够

当前最明显的问题不是“完全不会判断”，而是“判断结果偶尔不稳定”：

- 本地模型仍会频繁输出非法 JSON，需要 repair 才能继续；
- repair 本身也不是 100% 成功，因此必须依赖 deterministic fallback；
- 同一个 case 多次运行，topic relation、topic grounding、candidate agents 仍会有波动；
- 小模型在 schema 变长后更容易掉字段、偷懒泛化、用抽象句子代替 grounded evidence。

这说明当前系统已经具备“纠错能力”，但还没有达到“输出天然稳定、错误率足够低”的
工业级状态。

### 2. 语义表达仍偏薄

虽然我们已经引入了 `richIntent`、`confidenceByDimension`、`intentSteps`，但整体上
仍然更像“增强版路由结果”，还不是完整的任务语义表示：

- `intentSteps` 现在主要服务于 prompt 注入，还没有成为系统级执行契约；
- step 的 `action` 和 `target` 仍然比较粗，很多时候是 fallback 文本，而不是精确参数；
- 缺少更强的 argument extraction，例如 reminder time、output format、deliverable path、
  comparison set、约束条件、成功标准；
- 当前 schema 仍偏向单轮理解，还没有把“用户期望的最终产物”表达得足够清楚。

工业级系统通常不只知道“这是 recall + analyze + schedule”，还要知道“分析什么、产出
什么格式、提醒在什么时间、缺什么参数、哪些步骤必须确认”。

### 3. Multi-Intent 只完成了识别层，尚未进入执行层

这块现在处于“阶段一可用”：

- 我们已经能识别并暴露多步骤意图；
- 也已经把 `<intent_plan>` 注入给主模型；
- 但 executor、tool orchestration、subagent routing 仍然主要按旧执行模式工作。

这意味着：

- 系统已经“看见”多意图，但还不能严格保证按 step 顺序执行；
- step 之间的依赖关系还没有成为 runtime 约束；
- clarification policy 和 memory policy 还没有完整按 step 粒度消费；
- 最终成功很大程度仍依赖主 LLM 一次性把所有步骤都处理对。

工业级多意图系统通常需要从“识别 steps”进一步走到“按 steps 规划并执行 steps”。

### 4. topic understanding 仍然受模型表述噪声影响

这轮演进里，topic grounding 已经明显比之前好，但它仍暴露出一个现实问题：

- 模型会把普通新问题误判成 `current_context_reference`；
- 模型会给出抽象总结，而不是来自原文的 grounded evidence；
- `referencesRecentHistory=false` 与 `topicAnalysis.relation=current_context_reference`
  这种语义冲突仍会出现，需要代码层再修正。

这说明 topic understanding 还没有完全从“模型主观总结”升级为“有证据约束的 topic
inference”。工业级系统一般要求 relation、history topic、current topic、evidence
之间高度一致，不能靠日志里人工解释。

### 5. recall / personal / mixed 的边界仍然脆弱

这部分已经比最初稳很多，但仍不是彻底解决：

- “记得”“之前”“上次”这类自然语言在中文里高度多义，容易引入假阳性；
- `recallCue`、`personalCue`、external entity 之间的优先级需要大量 guardrail；
- 同一句话既可能是“问我的偏好”，也可能是“结合我的偏好分析外部对象”，语义边界很细；
- 当前很多正确结果来自 guardrail 组合，而不是模型本身天然稳定地区分。

工业级系统可以接受 guardrail，但不能长期依赖不断叠加 case-by-case 规则，否则维护
成本会持续上升。

### 6. 评测覆盖仍不足以证明“工业级”

我们已经有真实模型 eval，这非常关键，但它距离工业级验证还有差距：

- 当前 case 数量还不够大，覆盖的业务面有限；
- 已经具备失败样本 candidate 输出，但还缺少大规模真实 query 回放、按分布采样和线上日志自动回灌；
- 已经有 core policy trace baseline，但还没有稳定的跨模型回归基线、分版本趋势追踪、失败聚类分析；
- 还没有把“波动性”本身做成指标，例如同一 case 重跑 10 次的一致性。

工业级不是“这一轮 23/23 通过”，而是“长期、跨模型、跨版本、跨分布地稳定通过”。

### 7. 与下游模块的契约还不够硬

当前 intent layer 已经开始影响 memory injection、clarification、agent routing，
但耦合还不够深：

- memory policy 还主要是按 subject / memoryTarget / contextDependency 推断；
- clarification policy 还没有完全按 `intentSteps` 和 step risk 驱动；
- agent routing 仍然部分依赖 candidate heuristic，而不是完整 execution plan；
- 执行失败后的反馈还不会反向修正 intent understanding。

工业级系统通常要求 intent layer 成为“统一语义入口”，下游模块消费同一份 contract，
而不是每层都再做一次自己的轻量理解。

### 8. 观测与运营能力还偏初级

当前已经有日志和 targeted eval，但还缺少工程化运营能力：

- 没有统一 dashboard 看 subject/taskType/memoryTarget 的错误率走势；
- 已经开始按 policy reason 和 confidence dimension 分桶，但还没有按模型、场景、语言、
  query length 建立长期质量统计；
- 没有 failure taxonomy 和 root-cause 标注体系；
- 还没有把 repair rate、fallback rate、topic conflict rate 作为健康指标长期监控。

工业级 intent system 必须既能“做对”，也能“看见自己什么时候没做对”。

## 一个务实判断

如果分级来看，我会把 Jarvis 当前的 intent-understanding 层放在：

- 不是“弱规则路由”；
- 已经超过“单纯依赖 LLM 自由发挥”；
- 属于“有 schema、有 guardrail、有 eval 的中级语义路由系统”；
- 但还没有进入“工业级强意图理解系统”。

它现在最接近的状态是：

> 一个已经具备正确演进方向、局部能力较强、但在稳定性、执行闭环和运营能力上仍需
> 明显补强的 intent platform。

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
