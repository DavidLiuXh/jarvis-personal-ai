# Universal Memory Layer 设计草案

本文档定义从 Jarvis 当前实现中沉淀一个通用 Memory Runtime 的目标架构。

这个 Memory Runtime 不只是一个向量检索模块，而是一套完整的 agent 记忆层：

- 意图理解层：判断用户请求是否需要记忆、需要哪类记忆、是否存在边界风险；
- Session Memory：当前会话和近期上下文；
- Fact Memory：稳定用户事实、偏好、画像和长期 profile；
- Entry Memory：历史对话、任务、事件、决策和经验记录；
- Retrieval / Injection：检索、精排、预算控制、注入和拒绝理由；
- Eval / Feedback Loop：从真实使用中沉淀失败样本，持续回归。

## 1. 目标

Jarvis 当前构建在 Gemini CLI 运行时上，但最近增强的 intent understanding、memory policy、memory injection 和 eval 体系已经具备通用价值。

最终目标是把这些能力抽成一个可复用层，使其他 agent 项目可以在不继承 Jarvis/Gemini CLI runtime 的情况下复用：

- 稳定的意图理解；
- 可解释的 memory policy；
- 三层记忆模型；
- 可替换的模型、embedding、vector store 和 reranker adapter；
- 可回归的 eval / runtime feedback 机制。

这层的定位是：

```text
Application Agent Runtime
  uses
Intent Runtime
  uses
Memory Runtime
  uses
Model / Embedding / Vector / Storage Adapters
```

其中边界定义为：

- `intent-runtime`：意图 schema、policy、clarification、execution plan、step runtime、feedback schema。
- `memory-runtime`：memory contract、retrieval、injection、memory stores、memory runtime events。
- `jarvis-core adapters`：JarvisIntentResolver、JarvisMemoryStores、ToolRouter integration、channels、scheduler。

通用 runtime 不应该直接依赖 Gemini CLI、JarvisAgent、ToolRouter、具体 channel、具体 scheduler 或某个特定数据库实现。Jarvis 特有行为应通过 adapter 或 extension point 注入。

## 2. 为什么要把 Intent Understanding 放进 Memory Layer

通用 memory 层不能只从“用户输入文本”直接检索记忆。原因是同一句话是否需要记忆，取决于意图。

例如：

| 用户输入                    | 正确判断       | Memory 行为                               |
| --------------------------- | -------------- | ----------------------------------------- |
| `上次苹果发布会发布了什么`  | 外部历史事件   | 不注入个人记忆                            |
| `我们上次聊过苹果发布会吗`  | 会话历史召回   | 检索 session / entry memory               |
| `结合我的风险偏好分析 NVDA` | mixed          | 注入受限 fact memory                      |
| `继续刚才那个方案`          | 当前上下文引用 | 优先 session history，不急于查长期 memory |
| `Javis，我是 David Liu`     | 用户事实陈述   | 更新 fact，不应误当作 recall              |

如果 memory 层没有 intent understanding，就只能靠关键词判断“上次”“之前”“记得”，会导致：

- external 请求误注入 personal memory；
- 当前上下文引用误查长期记忆；
- 用户事实更新误判成记忆召回；
- subagent/tool 层各自重新理解用户请求，边界不一致。

因此，Intent Understanding 是 Universal Memory Layer 的入口控制器。它负责把自然语言请求转换为稳定的 Memory Contract。

## 3. 总体架构

```mermaid
flowchart TD
    A["User Input"] --> B["Intent Understanding"]
    B --> C["Memory Policy"]
    C --> D{"Need Memory?"}
    D -- "No" --> E["Return Empty Memory Context"]
    D -- "Yes" --> F["Query Planning"]
    F --> G["Session Memory"]
    F --> H["Fact Memory"]
    F --> I["Entry Memory"]
    G --> J["Retrieval Result"]
    H --> J
    I --> J
    J --> K["Rerank / Filter / Entity Expansion"]
    K --> L["Memory Injection Planner"]
    L --> M["Memory Context"]
    M --> N["Agent Runtime Prompt / Tool / Subagent"]
    B --> O["Clarification Policy"]
    O --> P{"Need Clarification?"}
    P -- "Yes" --> Q["Ask User / Block"]
    P -- "No" --> C
    N --> R["Runtime Feedback Collector"]
    Q --> R
```

核心原则：

- LLM 负责开放语义理解；
- policy 负责确定性边界；
- memory policy 负责是否查、查什么、怎么查；
- injection planner 负责预算、排序和最终可注入内容；
- runtime feedback 负责把真实失败样本沉淀成 eval candidates。

## 4. 三层记忆模型

### 4.1 Session Memory

Session Memory 表示当前会话和近期上下文。

用途：

- 支持“继续刚才那个方案”“这个呢”“按上面的来”；
- 支持 topic continuity 和 topic shift 判断；
- 支持短期澄清答案合并；
- 支持当前会话摘要。

原因：

- session history 是最强的短期上下文，不应该和长期向量记忆混在一起；
- 当前上下文引用通常不需要查长期记忆，查错反而会污染回答；
- session 层可以保留更高保真的原始 turns，而长期 memory 应该更压缩、更稳定。

建议接口：

```ts
export type ConversationTurn = {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
};

export type SessionMemory = {
  scope: "session";
  sessionId: string;
  turns: ConversationTurn[];
  summary?: string;
  topicState?: TopicState;
};
```

### 4.2 Fact Memory

Fact Memory 表示稳定、可复用的用户事实和长期 profile。

用途：

- 用户偏好；
- 用户身份；
- 风险偏好；
- 长期项目背景；
- 明确保存的个人资料。

原因：

- fact 应该是经过 distill / validation 的稳定信息，不应该把每条对话原文都当 fact；
- fact 通常需要较高 precision，错注入会明显影响回答；
- fact 需要 confidence、sourceRefs、updatedAt，便于冲突处理和回溯。

建议接口：

```ts
export type FactMemory = {
  id: string;
  scope: "fact";
  subject: "user" | "preference" | "profile" | "project" | "relationship";
  content: string;
  confidence: number;
  sourceRefs: string[];
  createdAt: string;
  updatedAt: string;
};
```

### 4.3 Entry Memory

Entry Memory 表示历史对话、任务、事件、决策和经验记录。

用途：

- 召回“之前关于梓潼的讨论”；
- 召回历史任务执行过程；
- 召回某次决策背景；
- 支持按时间窗口检索；
- 支持 episodic memory。

原因：

- entry 比 fact 更接近历史事件，可能不是长期稳定事实；
- entry 需要时间、实体、来源和原文摘要；
- entry 可以承载“发生过什么”，fact 承载“稳定成立什么”。

建议接口：

```ts
export type EntryMemory = {
  id: string;
  scope: "entry";
  kind: "conversation" | "task" | "decision" | "event" | "reflection";
  content: string;
  entities: string[];
  timestamp: string;
  sourceRefs: string[];
};
```

## 5. Memory Contract

Intent Understanding 层应该输出一个对 memory 层稳定可消费的 contract。

当前 Jarvis 的 `IntentFrame` 已经包含这些信息：

- `subject`: `personal` / `external` / `mixed`
- `taskType`: `chat` / `recall` / `analyze` / `execute` / `delegate` / `schedule`
- `needsMemory`
- `semanticEvidence.memoryRecall.target`
- `referencesRecentHistory`
- `topicShifted`
- `confidenceByDimension`
- `richIntent.contextDependency`
- `intentSteps`
- `policyTrace`

通用层可以在此基础上收敛成更明确的 Memory Contract：

```ts
export type MemoryContract = {
  needMemory: boolean;
  subjectBoundary: "personal" | "external" | "mixed";
  targetScopes: Array<"session" | "fact" | "entry">;
  memoryTarget:
    | "none"
    | "current_context"
    | "conversation_history"
    | "user_profile"
    | "episodic_event"
    | "project_context";
  query: {
    raw: string;
    rewritten?: string;
    entities: string[];
    timeRange?: DateRange;
  };
  confidence: {
    subject: number;
    target: number;
    query: number;
  };
  constraints: {
    allowPersonalFacts: boolean;
    allowSessionHistory: boolean;
    allowEntries: boolean;
    maxChars: number;
  };
  reasons: string[];
  policyTrace: IntentPolicyTraceEntry[];
};
```

原因：

- `IntentFrame` 是完整意图表达，Memory Contract 是 memory 子系统的稳定入口；
- 这样 tool、subagent、main response 可以消费同一份 memory decision；
- 其他 agent 项目可以替换自己的 intent schema，但只要能生成 Memory Contract，就能复用 memory runtime。

## 6. 核心接口

### 6.1 Memory Runtime

```ts
export interface MemoryRuntime {
  understand(input: UserTurnInput): Promise<IntentFrame>;

  planMemory(input: {
    prompt: string;
    history: ConversationTurn[];
    intent: IntentFrame;
  }): Promise<MemoryContract>;

  retrieve(contract: MemoryContract): Promise<MemoryRetrievalResult>;

  inject(input: {
    prompt: string;
    intent: IntentFrame;
    contract: MemoryContract;
    retrieval: MemoryRetrievalResult;
    budget: TokenBudget;
  }): Promise<MemoryInjectionResult>;

  observe(event: MemoryRuntimeEvent): Promise<void>;
}
```

当前实现状态：

- `jarvis/src/memory-runtime/runtime.ts` 已提供 `MemoryRuntime` 接口；
- 同文件已提供 `DefaultMemoryRuntime`，通过依赖注入串联 `understand -> planMemory -> retrieve -> inject -> observe`；
- 这层不直接依赖 JarvisAgent、ToolRouter、Gemini CLI 或具体数据库；
- Jarvis 当前主路径暂未整体切到 `DefaultMemoryRuntime`，仍由 `agent.ts` 编排，以降低迁移风险。

原因：

- 先提供可执行 runtime class，可以让其他 agent 项目按同一个生命周期接入；
- 通过依赖注入保持具体 resolver、store、reranker、observer 可替换；
- Jarvis 主流程先保持稳定，避免把 runtime 抽象和线上行为迁移混在同一次改动里。

### 6.2 Adapter 边界

通用层不直接绑定具体模型或存储。

```ts
export interface IntentModelClient {
  generateJson(input: {
    system: string;
    prompt: string;
    temperature?: number;
  }): Promise<string>;
}

export interface EmbeddingClient {
  embed(text: string): Promise<number[]>;
}

export interface VectorStore<T> {
  search(input: {
    query: string;
    topK: number;
    filters?: Record<string, unknown>;
  }): Promise<Array<{ item: T; score: number }>>;
}

export interface Reranker {
  rerank<T>(input: {
    query: string;
    candidates: Array<{ item: T; text: string }>;
  }): Promise<Array<{ item: T; score: number }>>;
}
```

原因：

- 不同 agent 项目可能使用 OpenAI、Gemini、Ollama、vLLM 或云厂商模型；
- vector store 可能是 sqlite-vec、pgvector、Qdrant、Milvus、Pinecone；
- reranker 可能不存在，也可能是 cross-encoder、本地 ONNX 或 API；
- adapter 边界可以让 memory runtime 保持稳定。

## 7. Jarvis 当前实现映射

| 通用层能力           | Jarvis 当前实现                                        |
| -------------------- | ------------------------------------------------------ |
| Intent Understanding | `jarvis/src/core/intentResolver.ts`                    |
| Policy Layer         | `jarvis/src/memory-runtime/intentPolicy.ts`            |
| Clarification        | `jarvis/src/memory-runtime/clarificationPolicy.ts`     |
| Memory Policy        | `jarvis/src/memory-runtime/intentAwareMemoryPolicy.ts` |
| Injection Planner    | `jarvis/src/memory-runtime/memoryInjectionPlanner.ts`  |
| Session Recall       | `jarvis/src/core/conversationRecall.ts`                |
| Intent Plan          | `jarvis/src/intent-runtime/executionPlan.ts`           |
| Runtime Feedback     | `jarvis/src/core/runtimeIntentFeedbackCollector.ts`    |
| Runtime Integration  | `jarvis/src/core/agent.ts`                             |
| Model Routing        | `jarvis/src/core/localModelRouter.ts`                  |
| Fact / Entry Storage | `MemoryService` 及其底层存储                           |

当前已经抽到通用层的模块：

1. `IntentFrame` / `MemoryContract` / `ClarificationQuestion` 等通用 types；
2. `intentPolicy.ts`；
3. `clarificationPolicy.ts`；
4. `intentAwareMemoryPolicy.ts`；
5. `memoryInjectionPlanner.ts`；
6. `DefaultMemoryRuntime` 和 adapter interfaces。

仍主要停留在 Jarvis core 的模块：

1. `IntentResolver` 实现本体；
2. `runtimeIntentFeedbackCollector.ts`；
3. `MemoryService` 及具体 fact / entry / vector store 实现；
4. Jarvis 主流程中的 retrieval / prompt refresh 编排。

## 8. 当前阻碍复用的耦合点

### 8.1 模型调用耦合

`intentResolver.ts` 当前依赖 `IntentModelClient`，不再直接依赖 `ollamaGenerate`。

Jarvis 默认路径通过 `JarvisOllamaIntentModelClient` 使用本地 Ollama。通用层同时提供不依赖 Jarvis core 的 `OllamaIntentModelClient`，其他项目可以提供 OpenAI / Gemini / vLLM adapter。

### 8.2 ToolRouter 类型耦合

`clarificationPolicy.ts` 已不再依赖 `toolRouter.ts` 的 `AskUserQuestion` 类型。

`ClarificationQuestion` 已迁入通用 `memory-runtime/types.ts`。ToolRouter 反向消费该 schema。

### 8.3 Jarvis 领域语义耦合

`candidateAgents`、`investment-analysis`、部分 skill / subagent 决策是 Jarvis 项目语义。

应拆成：

- 通用字段：subject、taskType、memoryTarget、risk、steps；
- 应用字段：candidateAgents、domain skills、project-specific routing hints。

### 8.4 Runtime 接入耦合

当前 memory planning、retrieval、prompt refresh、tool execution 编排仍在 `agent.ts`。

`DefaultMemoryRuntime` 已存在，但 Jarvis 主流程尚未整体切换。后续应让 `agent.ts` 只负责调用 runtime，不直接承载 memory retrieval / injection 编排。

### 8.5 Memory Store 耦合

`MemoryService`、session summary、fact search、entry search、entity expansion 和 reranker 仍是 Jarvis 具体实现。

后续应抽出：

- `SessionMemoryStore`；
- `FactMemoryStore`；
- `EntryMemoryStore`；
- `MemoryRetriever`；
- `MemoryObserver`。

原因：

- 当前 policy 和 contract 已通用，但 retrieval 仍绑定 Jarvis 数据结构；
- 不抽 store adapter，其他 agent 项目只能复用意图和策略，不能复用完整记忆检索链路；
- store adapter 是从“参考实现”走向“可嵌入 runtime”的关键剩余边界。

## 9. 迁移路线

### Phase 1：边界文档和类型冻结

目标：

- 明确 Universal Memory Layer 的职责边界；
- 定义 Memory Contract；
- 列出 Jarvis 当前模块映射；
- 确认哪些字段是通用，哪些字段是 Jarvis-specific。

完成标准：

- 本文档存在并持续更新；
- `intent-understanding-flow.md` 链接到本文档；
- 后续代码改造不再扩大 Jarvis runtime 和 memory logic 的耦合。

### Phase 2：新增接口层，不移动实现

目标：

- 新增 `packages/memory-runtime` 或 `jarvis/src/memory-runtime`；
- 先放通用 types/interfaces；
- Jarvis 现有实现逐步引用这些类型；
- 不改变运行时行为。

建议目录：

```text
packages/memory-runtime/
  src/
    intent/
    policy/
    stores/
    retrieval/
    injection/
    feedback/
    adapters/
```

完成标准：

- `IntentModelClient`、`MemoryContract`、`MemoryRuntime` 类型稳定；
- `ClarificationQuestion` 从 ToolRouter 类型中解耦；
- 现有测试通过。

当前实现入口：

```text
jarvis/src/memory-runtime/
  adapters.ts
  runtime.ts
  types.ts
  index.ts
```

当前实现状态：

- `IntentModelClient`、`MemoryContract`、`MemoryRuntime` 类型已稳定；
- `IntentFrame`、`IntentStep`、`IntentEvidence`、`IntentPolicyTraceEntry` 等 intent schema 已迁入 `memory-runtime/types.ts`；
- `ClarificationQuestion` 已从 ToolRouter 类型中解耦；
- `memory-runtime` 目录已经没有对 `core/*` 的反向 import；
- Jarvis 现有运行路径保持兼容。

### Phase 3：迁移纯逻辑模块

目标：

- 迁移 policy、clarification、memory policy、injection planner；
- 保持 Jarvis import 路径可兼容；
- 对每个迁移模块跑现有单测。

优先级：

1. `intentPolicy.ts`
2. `clarificationPolicy.ts`
3. `intentAwareMemoryPolicy.ts`
4. `memoryInjectionPlanner.ts`
5. `runtimeIntentFeedbackCollector.ts`

原因：

- 这些模块最接近纯逻辑；
- 对 Gemini CLI runtime 依赖少；
- 最适合作为通用层第一批资产。

当前实现状态：

- `intentPolicy.ts` 已迁移到 `jarvis/src/memory-runtime/intentPolicy.ts`；
- `clarificationPolicy.ts` 已迁移到 `jarvis/src/memory-runtime/clarificationPolicy.ts`；
- `intentAwareMemoryPolicy.ts` 已迁移到 `jarvis/src/memory-runtime/intentAwareMemoryPolicy.ts`；
- `memoryInjectionPlanner.ts` 已迁移到 `jarvis/src/memory-runtime/memoryInjectionPlanner.ts`；
- 上述模块已改为依赖 `memory-runtime/types.ts`，不再反向依赖 `jarvis/src/core/*`；
- `jarvis/src/core/*` 保留兼容 re-export，现有 Jarvis import 路径不变。

### Phase 4：抽 IntentResolver adapter

目标：

- 把 `ollamaGenerate` 替换成 `IntentModelClient`；
- 把 focused extractors 也改为通过 model adapter 调用；
- 支持不同项目选择不同本地或远端模型。

完成标准：

- Jarvis 使用 Ollama adapter 行为不变；
- eval runner 可以切换多个 model client；
- resolver 不再直接 import `ollamaClient.ts`。

当前实现状态：

- `IntentResolver` 依赖通用 `IntentModelClient`；
- 默认 Jarvis 路径使用 `JarvisOllamaIntentModelClient`，行为保持为本地 Ollama，并兼容现有 core 测试 mock；
- 通用 `memory-runtime/OllamaIntentModelClient` 已独立实现，不依赖 Jarvis core；
- JSON repair、memory target extractor、entity hints extractor 和主 intent seed 都通过同一个 model adapter；
- `scripts/run_intent_evals.ts` 显式构造 `OllamaIntentModelClient` 后传入 resolver，为后续切换 OpenAI/Gemini/vLLM adapter 留出入口；
- `IntentResolver` 不再直接 import `ollamaClient.ts`。

### Phase 5：统一 main / tool / subagent memory policy

目标：

- main response、tool、subagent 都消费同一份 Memory Contract；
- external 请求不能在 subagent 层泄漏 personal memory；
- recall fallback 继承 router 的 time range 和 memory target；
- subagent prompt 显式携带 memory decision。

原因：

- 当前主路径已经 intent-aware，但 subagent/tool 层仍可能独立注入 memory；
- 这是从“Jarvis 内部优化”走向“通用 memory runtime”的关键边界。

当前实现状态：

- `IntentAwareMemoryPolicy` 现在同时产出 `MemoryContract`；
- main response path 仍通过 intent-aware policy 做 facts / summary / entry 检索和注入；
- `ToolRouter` 每轮接收同一份 `MemoryContract`；
- `generalist` / `codebase_investigator` subagent prompt 会显式携带 `<memory_decision>`；
- subagent 只有在 contract 允许时才检索 personal facts / entries；
- external / external_past_event / no-memory contract 会阻止 subagent personal memory 注入；
- `recall_memory` 在 contract 禁止 personal entries 时返回拒绝说明，不读取长期个人记忆；
- `recall_memory` 空 query fallback 优先使用 contract 的 rewritten query，并继续继承 router 的 time range / date range。

### Phase 6：DefaultMemoryRuntime 和 core 反向依赖清理

目标：

- 提供可执行的 `DefaultMemoryRuntime`；
- 将 `IntentFrame` 等 intent schema 迁入通用层；
- 清理 `memory-runtime` 对 `core/*` 的反向依赖；
- 保持 Jarvis 当前 import 路径和运行行为兼容。

原因：

- 没有 runtime class 时，通用层只有接口和散落函数，其他项目仍需要自己拼生命周期；
- `memory-runtime -> core` 的反向依赖会阻止它成为独立 package；
- 先清理类型和纯逻辑依赖，再迁移 storage / retrieval，风险更低。

当前实现状态：

- `DefaultMemoryRuntime` 已实现；
- `IntentFrame`、`IntentStep`、`IntentEvidence`、`TopicAnalysis`、`IntentPolicyTraceEntry` 等 schema 已迁入 `memory-runtime/types.ts`；
- `intentPolicy`、`clarificationPolicy`、`intentAwareMemoryPolicy`、`memoryInjectionPlanner` 已不再 import `core/*`；
- `IntentExecutionPlan` 和 `IntentStepRuntime` 已迁入 `jarvis/src/intent-runtime/executionPlan.ts`，`core/intentExecutionPlan.ts` 仅保留兼容 re-export；
- 通用 `OllamaIntentModelClient` 已不再 import `core/ollamaClient.ts`；
- Jarvis core 增加 `JarvisOllamaIntentModelClient`，用于保持现有默认 Ollama 行为和测试兼容；
- `IntentResolver` 继续作为 Jarvis core 实现，但其公开类型从通用层 re-export。

剩余限制：

- Jarvis 主流程已经开始调用 `DefaultMemoryRuntime`；
- `DefaultMemoryRuntime.retrieve()` 仍需要由宿主项目注入具体 retrieval 实现，Jarvis 通过 `JarvisMemoryStores` 提供默认实现。

### Phase 7：Storage / Retrieval Adapter

目标：

- 抽出 session / fact / entry 三类 store adapter；
- 提供默认 `DefaultMemoryRetriever`；
- 用 Jarvis `MemoryService` 包装出默认 adapter；
- 保持 Jarvis 当前主流程行为不变。

原因：

- `MemoryContract` 只说明“该不该查、查哪层、用什么 query”，还不应该知道底层数据库；
- 不同 agent 项目的事实库、会话库、向量库和 reranker 差异很大，必须通过 store adapter 隔离；
- 先把 retrieval adapter 抽出来，可以让其他项目复用 contract 和 retrieval lifecycle，同时不强迫 Jarvis 立即改写主流程；
- Jarvis 当前 `refreshContext()` 里还有 query rewrite、recent conversation recall、summary fallback、skill retrieval 等行为，直接替换成默认 retriever 会带来行为漂移。

当前实现状态：

- `memory-runtime/retrieval.ts` 已定义：
  - `FactMemoryStore`
  - `EntryMemoryStore`
  - `SessionMemoryStore`
  - `DefaultMemoryRetriever`
- `DefaultMemoryRetriever` 根据 `MemoryContract` 决定是否检索 session / fact / entry；
- external 或 no-memory contract 不会调用任何 store；
- `DefaultMemoryRetriever` 已支持 runtime extension points：
  - `planQuery`：按 session / fact / entry 分别规划 query；
  - `augmentEntries`：把 recent conversation recall 这类非 store 召回结果并入 entry memory；
  - `fallbackSession`：在 session vector summary 无命中时执行 summary fallback；
- `SkillRetrievalExtension` 已作为 prompt 侧资源检索扩展点定义；
- `core/jarvisMemoryStores.ts` 已提供 Jarvis adapter：
  - `JarvisFactMemoryStore` 包装 `MemoryService.searchFacts()`
  - `JarvisEntryMemoryStore` 包装 `MemoryService.searchWithScore()`
  - `JarvisSessionMemoryStore` 包装 `MemoryService.searchSummaryChunks()`
  - `createJarvisMemoryStores()` 一次性生成三类 adapter
- Jarvis `agent.ts` 的主响应路径已经开始通过 `DefaultMemoryRetriever` 检索 facts / entries / session summary；
- Jarvis query rewrite、recent conversation recall、summary fallback 和 skill retrieval 已通过 extension points 保留；
- 新增单测覆盖默认 retriever 和 Jarvis adapter。

剩余限制：

- skill retrieval 仍在主响应路径调用，只是已经被抽象为 extension shape；
- runtime feedback collector 已接入 `MemoryRuntime.observe()` 的 intent / retrieval / injection 事件；
- `DefaultMemoryRuntime` 目前接管的是主响应路径的 memory lifecycle，tool/subagent 执行层仍通过 `MemoryContract` 消费 memory decision。

### Phase 8：DefaultMemoryRuntime 接入主响应路径

目标：

- Jarvis 主响应路径通过 `DefaultMemoryRuntime` 串起 `understand -> planMemory -> retrieve -> inject -> observe`；
- 保留现有 prompt 注入质量和日志；
- 将 memory runtime 事件进入统一反馈通道。

原因：

- 只有 store/retriever adapter 还不够，主流程必须真正消费 runtime lifecycle，Universal Memory Layer 才是运行时而不是工具函数集合；
- `observe()` 必须成为 runtime 事件入口，才能沉淀 retrieval miss、injection empty、external leakage 等真实样本；
- 先接入主响应路径，tool/subagent 已经通过 `MemoryContract` 共享同一份 decision，迁移风险可控。

当前实现状态：

- `agent.ts#refreshContext()` 已通过 `DefaultMemoryRuntime` 执行：
  - `understand`：接收当前已解析的 `IntentFrame`，并发出 `intent_resolved` event；
  - `planMemory`：调用 `buildIntentAwareMemoryPolicy()` 产出 `MemoryContract`；
  - `retrieve`：调用 `DefaultMemoryRetriever`，并保留 query rewrite、recent conversation recall、summary fallback；
  - `inject`：调用 `MemoryInjectionPlanner` 生成 facts / summary / prewarm 注入内容；
  - `observe`：统一进入 `RuntimeIntentFeedbackCollector.recordMemoryEvent()`；
- `RuntimeIntentFeedbackCollector` 已支持 memory runtime feedback：
  - `memory_retrieval_empty`
  - `external_memory_leakage`
  - `memory_injection_rejected`
  - `memory_injection_empty`
- 新增单测覆盖 memory feedback 记录和 leakage signal。

剩余限制：

- `DefaultMemoryRuntime` 尚未接管 skill retrieval；
- `DefaultMemoryRuntime` 尚未接管 tool/subagent 执行，只负责主响应 memory lifecycle；
- memory feedback 目前进入 candidate JSONL，但还没有自动进入稳定 eval case。

### Phase 9：Intent Runtime 边界稳定化

目标：

- 防止 `memory-runtime` 继续吸收 execution / orchestration 职责；
- 将 execution plan 和 step runtime 归入更准确的 `intent-runtime` 边界；
- 用自动检查守住通用层不能反向依赖 Jarvis core。

当前实现状态：

- 新增 `jarvis/src/intent-runtime`，并将 `IntentExecutionPlan` / `IntentStepRuntime` 迁入该目录；
- `jarvis/src/core/intentExecutionPlan.ts` 现在只做兼容 re-export；
- `push_to_channel` 已纳入 `IntentStepRuntime` 的 enforceable tool contract；
- 单步工具请求也会生成 execution contract，普通单步 LLM 请求仍不生成额外 plan；
- 新增 `scripts/check_runtime_boundaries.ts`；
- 新增 `npm run runtime:check-boundaries`，检查 `memory-runtime` 与 `intent-runtime` 不得 import `jarvis/src/core/*`。

剩余限制：

- `intent-runtime` 仍复用 `memory-runtime/types.ts` 与 `crudPolicy.ts`；
- `IntentResolver` 仍在 Jarvis core；
- tool/subagent execution 仍在 Jarvis core，尚未迁入 step orchestrator。

## 10. Eval 和反馈闭环

通用 memory 层必须内置 eval 思路，否则无法证明它比普通 RAG 更可靠。

至少需要四类 eval：

| Eval 类型          | 目标                                         |
| ------------------ | -------------------------------------------- |
| Intent eval        | subject/taskType/memoryTarget/steps 是否正确 |
| Memory policy eval | 是否该查 memory、查哪层 memory               |
| Retrieval eval     | 能否找回正确 fact/entry/session              |
| Injection eval     | 是否注入正确内容、拒绝错误内容               |

Runtime feedback 负责把真实使用样本沉淀成 candidate：

- router fallback；
- JSON repair / deterministic fallback；
- policy correction；
- low confidence dimension；
- clarification blocked；
- memory 注入错误；
- 用户显式纠错；
- tool/subagent memory 泄漏。

这些 candidate 需要人工 review 后进入稳定 eval cases，不能自动晋升。

## 11. 非目标

Universal Memory Layer 不应该负责：

- 具体 UI；
- 具体 channel，例如 WeChat、CLI、WebSocket；
- 具体 task scheduler；
- 具体 tool execution；
- 具体 Gemini CLI client；
- 业务领域 agent 的全部 prompt。

它只提供 memory 相关的理解、策略、检索、注入和反馈能力。

## 12. 当前结论

Jarvis 当前实现已经具备抽象出 Universal Memory Layer 的基础，但还没有达到开箱即用 package 的程度。

当前状态可以判断为：

- 作为参考实现：已经可用；
- 作为 Jarvis 内部子系统：已经基本成型；
- 作为其他 agent 项目的可复用库：意图、policy、contract、retrieval adapter、injection planner 和 runtime lifecycle 已具备复用基础；
- 作为通用开源 package：还需要迁移、文档、eval 和 API 稳定化。

当前最实际的下一步是将 Jarvis 主响应路径逐步改为调用 `DefaultMemoryRuntime` / `DefaultMemoryRetriever`，但要先把 Jarvis 特有的 query rewrite、recent conversation recall、summary fallback 和 skill retrieval 纳入 runtime extension points。这样可以避免为了抽象而牺牲现有召回质量。
