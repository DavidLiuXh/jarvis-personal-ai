# Jarvis System Prompt Structure

记录 Jarvis 每轮对话发送给 LLM 的完整 prompt 构成。

---

## 一、整体结构（三层）

```
┌─────────────────────────────────────────────────────────────┐
│                    SYSTEM INSTRUCTION                       │
│  （每轮对话前由 refreshContext() 重建，内容随查询变化）       │
├─────────────────────────────────────────────────────────────┤
│  ① Preamble（角色定义 + 核心规则）                           │
│  ② JARVIS OPERATIONAL FRAMEWORK v4.0（Jarvis 行为规范）     │
│  ③ <relevant_past_conversations>（vec_memories 预热）       │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│                  CONVERSATION HISTORY                       │
│  （随对话累积，启动时由摘要+最近N轮原始消息恢复）             │
├─────────────────────────────────────────────────────────────┤
│  [user]   [CONVERSATION HISTORY SUMMARY]                    │
│  [model]  Understood...                                     │
│  [user/model] × 最近 N 轮原始消息（默认 3 轮）              │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│                  CURRENT USER MESSAGE                       │
├─────────────────────────────────────────────────────────────┤
│  [user]   当前用户输入                                       │
└─────────────────────────────────────────────────────────────┘
```

---

## 二、System Instruction 详细构成

**代码入口**：`agent.ts` → `refreshContext(userPrompt)`

```typescript
// agent.ts
const defaultInstruction = buildJarvisPreamble();
const protocol = this.promptBuilder.buildFromFacts(facts, userPrompt, skills);
// prewarmSection = <relevant_past_conversations>...</relevant_past_conversations>
this.client
  .getChat()
  .setSystemInstruction(defaultInstruction + "\n" + protocol + prewarmSection);
```

### ① buildJarvisPreamble()

**文件**：`systemPromptBuilder.ts:14`  
**token 估算**：300 - 600

```
You are Jarvis, a deeply personalized AI assistant...

# Core Mandates

## Security & System Integrity
  - 凭证保护，不自动 commit

## Context Efficiency
  - 并行工具调用，减少轮次

## Tool Usage
  - 并行/顺序规则（wait_for_previous）
  - 文件编辑冲突规则
  - Shell 命令规则
  - 确认协议

## Memory
  - recall_memory：上下文不可见时必须先调用
  - save_memory：自动蒸馏，仅在用户明确要求时手动调用

## Tone & Style
  - 简洁直接，避免废话
  - GitHub-flavored Markdown
  - 工具用于行动，文本用于沟通
```

---

### ② JARVIS OPERATIONAL FRAMEWORK v4.0

**文件**：`systemPromptBuilder.ts:233` → `framework()` 方法  
**token 估算**：400 - 1200

```
# JARVIS OPERATIONAL FRAMEWORK v4.0

## I. EXECUTION CONTEXT
  ┌─ <memory_status>
  │  [CRITICAL_LIMITATION]: Long-term memory is currently offline.
  │  Do not reference past events unless they appear in
  │  <persistent_context> or <relevant_past_conversations>.
  │  If the user refers to past conversations or decisions,
  │  call 'recall_memory' first. DO NOT HALLUCINATE.
  └─ </memory_status>

  ┌─ <persistent_context>
  │  - [IDENTITY]: ...    ← identity facts，置顶（首因效应）
  │  - [BEHAVIOR]: ...    ← behavior facts
  │  - [SPECIFICATION]: ... ← specification facts
  │  - [INSIGHT]: ...     ← insight facts（importance≥7 且查询相关时，最多2条）
  │  （注：interaction_style facts 不在此处，在 style_constraints）
  └─ </persistent_context>

## II. OPERATIONAL PROTOCOLS（动态注入，由 selectProtocols(userPrompt) 决定）
  1. TOOL_USE_ATOMICITY          ← 始终注入
  2. CODE_MODIFICATION_PROTOCOL  ← 含代码关键词时（修改/edit/refactor 等）
  3. PUSH_TO_CHANNEL             ← 含推送关键词时（发到/微信/feishu 等）
  4. TASK_MANAGEMENT             ← 含任务关键词时（每天/定时/task 等）
  5. TASK_DECOMPOSITION          ← 始终注入
  6. SKILL_ACTIVATION            ← 有可用 skill 时

## III. OUTPUT CONSTRAINTS（近因效应 — 末尾最后通牒）
  - You are JARVIS: deterministic, precise, and system-native.
  - Skip conversational fillers. Use high-density information.
  - Use Markdown for structure. For financial/data analysis, use tables.
    For code, specify language and file path.

  ┌─ <style_constraints>（仅在有 identity 技术特征或 interaction_style facts 时生成）
  │  - [DEFAULT]: User is a technical professional...  ← 从 identity facts 推导
  │  - [USER_PREFERENCE]: ...  ← interaction_style facts（每条一行）
  └─ </style_constraints>
```

---

### ③ \<relevant_past_conversations\>（prewarm）

**文件**：`agent.ts:322`，拼接在 protocol 末尾  
**数据来源**：`memoryService.search(userPrompt, prewarmLimit)`，查询 `vec_memories`  
**token 估算**：0 - 600（默认最多 3 条，`prewarmLimit=3`）

```
<relevant_past_conversations>
[Long-term Memory 1]: [2026-04-17] User decided to use TypeScript...
[Long-term Memory 2]: [2026-04-18] Jarvis confirmed the project structure...
[Long-term Memory 3]: ...
</relevant_past_conversations>
```

---

## 三、Fact 注入规则

| Category            | 注入位置                    | 注入策略                                         |
| ------------------- | --------------------------- | ------------------------------------------------ |
| `identity`          | `<persistent_context>` 首位 | 无条件注入，置顶                                 |
| `behavior`          | `<persistent_context>`      | 按相关性排序，上限 `factRelevanceLimit`（默认5） |
| `specification`     | `<persistent_context>`      | 同上                                             |
| `insight`           | `<persistent_context>` 末尾 | importance≥7 且查询相关，最多2条                 |
| `interaction_style` | `<style_constraints>`       | 无条件注入，标签 `[USER_PREFERENCE]`             |

**检索策略**（`factRelevanceStrategy`）：

- `"jaccard"`（默认）：词汇重叠，适合关键词查询
- `"embedding"`（推荐）：语义相似度，适合自然语言查询；需配置 `factMaxDistance`（默认1.0）过滤低相关候选

---

## 四、注入顺序设计原理

基于 LLM 注意力的 **U 型曲线（Lost in the Middle）**：

```
注意力权重
    ↑
高  │█                                    █
    │█                                    █
    │ █                                  █
低  │  █████████████████████████████████
    └────────────────────────────────────→ 位置
       开头（首因）                末尾（近因）
```

| 位置           | 放什么                                                                   | 原因                                           |
| -------------- | ------------------------------------------------------------------------ | ---------------------------------------------- |
| 开头（首因）   | EXECUTION CONTEXT（memory_status + identity facts + persistent_context） | 奠定"我是谁、我知道什么、我失忆了什么"的基调   |
| 中间（塌陷区） | protocols + relevant_past_conversations                                  | 数据填充，LLM 会读但注意力较低                 |
| 末尾（近因）   | OUTPUT CONSTRAINTS + style_constraints                                   | 最后通牒，生成响应前看到的最后内容，遵循率最高 |

---

## 五、token 估算汇总

| 部分                            | 估算 token     |
| ------------------------------- | -------------- |
| ① buildJarvisPreamble           | 300 - 600      |
| ② FRAMEWORK（无 facts/prewarm） | 200 - 400      |
| persistent_context（facts）     | 100 - 400      |
| protocols（动态）               | 100 - 400      |
| style_constraints               | 0 - 100        |
| ③ relevant_past_conversations   | 0 - 600        |
| **合计**                        | **700 - 2500** |

---

## 六、注意事项

1. **FRAMEWORK 每轮重建**：`buildFromFacts()` 在每次 `refreshContext()` 时调用，facts 和 prewarm 内容随查询变化，protocols 由 `selectProtocols(userPrompt)` 动态决定。

2. **Conversation History 只在启动时注入一次**：`agentInitializer.resumeFromDisk()` 在启动时把 session summary + 最近 N 轮原始消息通过 `client.resumeChat()` 设置为初始历史，之后由 Gemini CLI 自动追加新消息。

3. **`[Long-term Memory]` vs Session History 区分**：`<relevant_past_conversations>` 里的内容标记为 `[Long-term Memory N]`，与 conversation history 里的当前 session 消息在格式上明确区分，减少模型时间线混淆。

4. **interaction_style 不在 persistent_context**：`interaction_style` facts 单独提取，注入 `<style_constraints>` 而不是 `<persistent_context>`，确保格式规则在末尾（近因）生效。

5. **insight 保守模式**：新生成的 insight 默认 importance=6，低于注入门槛（≥7），需经过多次被召回（`access_count≥3`）后才能升权到注入门槛。每轮最多注入2条。
