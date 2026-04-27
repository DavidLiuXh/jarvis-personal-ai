# Jarvis 记忆系统 Prompt 参考文档

本文档整理了 Jarvis 记忆系统中所有 LLM Prompt 的完整文本、触发场景、输入输出格式及调用链路。

---

## 总览

| 组件                                                   | 文件                     | 触发时机                   | 模型路由                                     | 输出格式           |
| ------------------------------------------------------ | ------------------------ | -------------------------- | -------------------------------------------- | ------------------ |
| [Fact 提取](#1-fact-提取--backgrounddistillerts)       | `backgroundDistiller.ts` | 每次对话后（异步）         | `reflection.provider`（同 consolidateFacts） | JSON facts 数组    |
| [Fact 合并](#2-fact-合并--consolidatefacts)            | `memory.ts`              | facts 数超过阈值时         | Ollama / Gemini                              | JSON facts 数组    |
| [Insight 生成](#3-insight-生成--reflect)               | `memory.ts`              | consolidateFacts 后 / 手动 | Ollama / Gemini                              | JSON insights 数组 |
| [会话事件提取](#4-会话事件提取--backfillsessionevents) | `memory.ts`              | 启动时 + 每 N 轮对话       | `reflection.provider`（同 consolidateFacts） | 事件行列表         |
| [实体提取](#5-实体提取--entityextractorts)             | `entityExtractor.ts`     | saveFact 后（异步）        | Ollama / Gemini                              | JSON links 数组    |
| [记忆注入](#6-记忆注入--systempromptbuilderts)         | `systemPromptBuilder.ts` | 每个用户输入前             | —                                            | System prompt 片段 |

---

## 1. Fact 提取 — `backgroundDistiller.ts`

**场景**：每次对话结束后在后台静默调用，从用户输入中提取值得长期记忆的事实。

**触发位置**：`agent.ts` → `distiller.distill(userPrompt, finalAssistantText)`

**模型路由**：`reflection.provider` 配置（与 `consolidateFacts`、`reflect` 相同）

- `provider=ollama` 且 `model` 已设置 → 使用本地 Ollama 模型
- `provider=ollama` 但 `model` 为空 → fallback 到 Gemini
- `provider=gemini` → 使用 `gemini-2.5-flash`

**Prompt**：

```
Extract persistent facts from the USER INPUT ONLY. Do NOT extract facts from the assistant output.

ENTITY ATTRIBUTION (CRITICAL):
- Only extract facts where the subject is the USER (e.g., "User likes X") or the JARVIS SYSTEM/PROJECT (e.g., "Jarvis must use Y").
- Do NOT extract facts about external entities, third-party projects, or topics being discussed conceptually.
- If the subject is an external product or another AI, IGNORE it.

Source rule (CRITICAL):
- Extract ONLY from: "User input" below
- NOT from: the assistant's response, even if the assistant enumerates or summarizes user information
- If the user asks "what are my hobbies?" and the assistant lists them, extract NOTHING
- Only extract what the user explicitly stated or revealed about themselves

Category definitions (mutually exclusive):
- identity: ONLY static facts about who the user IS — name, job title, profession, skills
- behavior: User's habits, hobbies, interests, lifestyle, routines, or recurring patterns
- preference: ONLY persistent, long-term response style preferences about FORMAT or STYLE
  Signs of persistence: "always", "every time", "from now on", "以后", "每次"
  Signs of one-time (IGNORE): "this time", "just now", "for this response", "这次"
- specification: Technical decisions, project constraints, or system rules FOR THIS PROJECT

Importance scoring (1-10):
- 9-10: Core identity facts, strong long-term preferences, critical project constraints
- 7-8:  Recurring behavior patterns, important project decisions, persistent style preferences
- 5-6:  Occasional habits, secondary preferences, project context that may change
- 3-4:  Weak signals, single-mention interests, low-confidence inferences
- 1-2:  Rarely useful, highly situational, almost certainly transient

Rules:
- Each fact belongs to exactly ONE category.
- Hobbies, interests → behavior, NOT identity.
- "preference" means response style only.
- Do not repeat the same information under different categories.
- Only extract facts that are genuinely new and worth remembering long-term.

Respond ONLY with JSON: {"found": true, "facts": [{"category": "...", "content": "...", "importance": 1-10}]}
If zero new data worth persisting, respond: {"found": false}

User input: ${userPrompt}
Assistant output (context only, do NOT extract from this): ${assistantText}
```

**输入**：

- `userPrompt`：用户原始输入
- `assistantText`：助手回复（仅上下文，不用于提取）

**输出**：

```json
{"found": true, "facts": [{"category": "identity|behavior|preference|specification", "content": "...", "importance": 1-10}]}
```

**后处理**：LLM 返回的 `importance` 会经过三因子公式重新计算：

```
final = round(0.35 × category_score + 0.25 × explicitness_score + 0.40 × llm_score)
```

---

## 2. Fact 合并 — `consolidateFacts()`

**场景**：facts 表行数超过 `consolidationThreshold`（默认 3）时自动触发，合并语义重复的 facts，修正错误分类。

**触发位置**：`memory.ts` → `saveFact()` → `consolidateFacts()`

**模型路由**：`reflection.provider`（`"ollama"` 或 `"gemini"`）

**Prompt**：

```xml
<task>
TASK: Consolidate the INPUT FACTS below into a clean JSON array.
OUTPUT FORMAT: You MUST output ONLY a valid JSON array. No markdown, no explanation, no prose.
CRITICAL: Do NOT output information about yourself, your name, your developer, or your capabilities.
</task>

<categories>
- identity: static facts about who the USER is (name, job, skills)
- behavior: user habits, hobbies, interests, routines
- preference: how the user wants responses formatted (tone, language, length)
- specification: technical decisions, project rules, system constraints
</categories>

<rules>
1. Merge semantically duplicate facts into one.
2. Fix miscategorized facts (hobbies → behavior, response style → preference).
3. Use English for all content.
4. Preserve the highest importance score among merged facts.
5. Output ONLY the JSON array, nothing else.
</rules>

<input_facts>
${factsText}
</input_facts>

<output>
[{"category": "identity|behavior|preference|specification", "content": "...", "importance": 1-10}]
</output>
```

**输入**：

- `factsText`：所有 facts，格式：`[${category}] (Importance: ${importance}) ${content}`

**输出**：

```json
[{"category": "...", "content": "...", "importance": 1-10}]
```

**后处理**：在事务中原子替换整个 facts 表，重新生成 embedding，写入 MEMORIES.md。

---

## 3. Insight 生成 — `reflect()`

**场景**：对积累的 facts 进行元层反思，生成跨 facts 的高阶洞察。insight 采用保守模式：新生成默认 importance=6，需 access_count≥3 才能升权到注入门槛（≥7）。

**触发位置**：`taskScheduler.ts` → 每晚 22:00 的 nightly-reflection 任务，或 `consolidateFacts()` 完成后

**模型路由**：`reflection.provider`（同上）

**Prompt**：

```xml
<task>
TASK: Generate 2-5 meta-level insights from the KNOWLEDGE below.
OUTPUT FORMAT: You MUST output ONLY a valid JSON array. No markdown, no explanation, no prose.
CRITICAL: Do NOT output information about yourself, your name, your developer, or your capabilities.
</task>

<knowledge>
${factsText}
${insightsSection}
</knowledge>

<rules>
- Each insight must synthesize MULTIPLE facts, not restate one fact
- If existing insights provided: merge/update/replace them, do NOT copy unchanged
- Be specific and actionable, not generic
- Output replaces ALL existing insights
- Use English for all content
</rules>

<output>
[{"category": "insight", "content": "...", "importance": 1-10}]
</output>
```

**输入**：

- `factsText`：非 insight 类别的 facts，格式：`[${CATEGORY}] ${content}`
- `insightsSection`：现有 insights（可选），格式：`[INSIGHT] ${content}`

**输出**：

```json
[{"category": "insight", "content": "...", "importance": 1-10}]
```

**保守模式规则**：

- 新 insight 无论模型输出什么，importance 强制 cap 到 6
- 文本完全相同的旧 insight：继承 access_count；access_count≥3 时 importance+1（上限 9）
- 注入门槛：importance≥7；每轮最多注入 2 条

---

## 4. 会话事件提取 — `backfillSessionEvents()`

**场景**：从历史会话文件中提取原子事件，存入 `vec_memories` 用于语义召回。启动时全量处理，之后每 N 轮对话增量处理新消息。

**触发位置**：

- `autoBackfill()`：Jarvis 启动后 60 秒
- `agent.ts`：每 `eventsExtractionInterval`（默认 20）轮对话触发一次

**模型路由**：`reflection.provider` 配置（与 `consolidateFacts`、`reflect` 相同）

**Prompt**：

```
Extract 3-10 atomic memory events from the following conversation.
Each event should be a single sentence describing a decision, solution, preference, or key fact.
Format: one event per line, starting with [${date}].
Only extract substantive items — ignore greetings, confirmations, and filler.

Conversation:
${convoText}

Events:
```

**输入**：

- `date`：从 session 文件名提取的日期（`YYYY-MM-DD`）
- `convoText`：最近 200 条消息，每条截断至 300 字符，格式：`User: ...\nJarvis: ...`

**输出**（每行一个事件）：

```
[2026-04-20] User decided to use TypeScript for the new project
[2026-04-20] Jarvis should always respond in Chinese
```

**后处理**：有效事件行存入 `vec_memories` 表，生成 embedding 用于后续语义搜索。

---

## 5. 实体提取 — `entityExtractor.ts`

**场景**：从 facts 中提取实体和关系，构建知识图谱，用于 `searchFacts` 时的图扩展召回。

**触发位置**：

- `saveFact()` 后通过 `setImmediate` 异步调用
- `consolidateFacts()` 完成后 30 秒调用 `backfillEntityLinks()`

**模型路由**：`entityExtraction.provider`（`"ollama"` 或 `"gemini"`）

**Prompt**：

```
Extract entities and relations from the following FACTS ONLY.

ENTITY TYPES (mutually exclusive):
- person: a human individual (e.g. "David", "the user")
- project: a software project or system (e.g. "Jarvis", "jarvis-personal-ai")
- technology: a tool, language, framework, or service (e.g. "TypeScript", "Ollama")
- concept: an abstract domain or topic (e.g. "investing", "running")

RELATION TYPES:
- is_a: subject is an instance of object
- has_skill: person has a skill
- works_on: person works on a project
- uses: project/person uses a technology
- interested_in: person is interested in a concept
- has_habit: person has a recurring behavior
- part_of: object is a component of subject

RULES:
- Only extract entities explicitly named or clearly implied in the facts.
- Normalize the user to their actual name if known, otherwise use "user".
- Do NOT invent entities or relations not grounded in the facts.
- Each relation must have exactly one subject and one object.
- If a fact yields no clear entity relation, skip it.

Input facts:
${factsText}

Respond ONLY with JSON:
{"found": true, "links": [{"subject": "...", "subject_type": "...", "relation": "...", "object": "...", "object_type": "..."}]}
If no entity relations can be extracted, respond: {"found": false}
```

**输入**：

- `factsText`：facts 列表，格式：`[${category}] ${content}`

**输出**：

```json
{
  "found": true,
  "links": [
    {
      "subject": "David",
      "subject_type": "person",
      "relation": "works_on",
      "object": "jarvis-personal-ai",
      "object_type": "project"
    }
  ]
}
```

**后处理**：存入 `entity_links` 表；为已处理的 `fact_id` 插入 `relation='processed'` 哨兵行防止重复处理。

---

## 6. 记忆注入 — `systemPromptBuilder.ts`

**场景**：每个用户输入前，将相关 facts 和历史记忆注入 system prompt，为当前对话提供持久化上下文。

**触发位置**：`agent.ts` → `refreshContext(userPrompt)` → `buildFromFacts(facts, userPrompt, skills)`

**注入流程**：

```
1. searchFacts(userPrompt)          → 相关 facts（preference 无条件注入，insight 需 importance≥7）
2. search(userPrompt, prewarmLimit) → 语义相似的历史对话片段（vec_memories）
3. buildFromFacts(facts)            → 构建 system prompt 片段
4. setSystemInstruction(...)        → 注入到当前对话
```

**最终 System Prompt 结构**：

```
[buildJarvisPreamble()]          ← 基础约定（角色、工具使用规范）

# JARVIS OPERATIONAL FRAMEWORK v4.0

## I. EXECUTION CONTEXT

<memory_status>
[CRITICAL_LIMITATION]: Long-term memory is currently offline...
</memory_status>

<persistent_context>
- [IDENTITY]: user is a software engineer named David
- [BEHAVIOR]: user likes cycling
- [SPECIFICATION]: project uses TypeScript
- [INSIGHT]: ...                  ← 仅 importance≥7 且查询相关时注入，最多 2 条
</persistent_context>

## II. OPERATIONAL PROTOCOLS
...（按 userPrompt 关键词动态选择）

## III. OUTPUT CONSTRAINTS
<style_constraints>
- [DEFAULT]: ...                  ← 从 identity facts 推导
- [USER_PREFERENCE]: ...          ← interaction_style facts
</style_constraints>

<relevant_past_conversations>     ← vec_memories 语义预热，最多 prewarmLimit 条
[Long-term Memory 1]: [2026-04-20] ...
</relevant_past_conversations>
```

**Facts 注入规则**：

| 类别                                      | 注入策略                                              |
| ----------------------------------------- | ----------------------------------------------------- |
| `preference`                              | 无条件注入（always inject）                           |
| `insight`                                 | importance≥7 且查询相关时注入，最多 2 条              |
| `identity` / `behavior` / `specification` | 按相关性排序，总量上限 `factRelevanceLimit`（默认 5） |

---

## 附：各 Prompt 的 JSON 容错处理

所有 LLM 响应的 JSON 解析都有两层容错：

1. **Markdown 代码块剥离**：`responseText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "")`
2. **截断修复**：若 JSON 数组不完整（缺少 `]`），截取到最后一个 `}` 后补 `]`，保留已生成的部分

相关代码位置：`memory.ts` 的 `consolidateFacts()` 和 `reflect()` 方法。
