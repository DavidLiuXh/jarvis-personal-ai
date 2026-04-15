# Jarvis System Prompt Structure

记录 Jarvis 每轮对话发送给 LLM 的完整 prompt 构成，以及精简前后的对比。

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

## 二、精简前：使用 getCoreSystemPrompt()（已废弃）

**代码**（`agent.ts`）：

```typescript
const defaultInstruction = getCoreSystemPrompt(
  this.client.config,
  this.client.config.getUserMemory(),
);
```

### System Instruction 完整构成

```
┌─────────────────────────────────────────────────────────────┐
│  ① getCoreSystemPrompt() 输出                               │
│                                                             │
│  Preamble                                                   │
│    "You are Gemini CLI, an interactive CLI agent..."        │
│                                                             │
│  # Core Mandates                                            │
│    ## Security & System Integrity                           │
│    ## Context Efficiency（详细规则 + examples）              │
│    ## Engineering Standards（代码规范、测试要求等）           │
│                                                             │
│  # Available Sub-Agents                                     │
│  # Agent Skills                                             │
│  # Primary Workflows（工具使用、代码编辑、Plan Mode）         │
│  # Operational Guidelines（Tone、Shell、Tool Usage）         │
│  # Sandbox / Git                                            │
│  GEMINI.md（userMemory）                                    │
│                                                             │
│  估计 token 数：3000 - 5000 tokens                          │
├─────────────────────────────────────────────────────────────┤
│  ② JARVIS OPERATIONAL FRAMEWORK v4.0                        │
│                                                             │
│  ## I. CORE PROTOCOLS (MANDATORY)                           │
│     1. TOOL_USE_ATOMICITY                                   │
│     2. CODE_MODIFICATION_PROTOCOL（含代码关键词时）          │
│     3. PUSH_TO_CHANNEL（含推送关键词时）                     │
│     4. TASK_MANAGEMENT（含任务关键词时）                     │
│     5. TASK_DECOMPOSITION                                   │
│     6. ACTIVE_RECALL (MANDATORY)                            │
│     7. SKILL_ACTIVATION（有 skill 时）                      │
│                                                             │
│  ## II. EXECUTION CONTEXT                                   │
│     <persistent_context>（facts，无排序优化）                │
│     <memory_status>[STRICT]: LONG-TERM LOGS NOT LOADED      │
│     <style_constraints>                                     │
│                                                             │
│  ## III. ROLE & TONE                                        │
│  ## IV. RESPONSE FORMATTING                                 │
│                                                             │
│  估计 token 数：500 - 1500 tokens                           │
├─────────────────────────────────────────────────────────────┤
│  ③ <relevant_past_conversations>（末尾，压住 Formatting）   │
│     [Past 1]: User: ... \nAssistant: ...                    │
│     估计 token 数：0 - 600 tokens                           │
└─────────────────────────────────────────────────────────────┘

总计估算：3500 - 7100 tokens / 轮

问题：
- Formatting 规则被 relevant_past_conversations 压到中间，近因效应失效
- identity facts 散落在 persistent_context 中间，首因效应未利用
- memory_status 标签弱（[STRICT]），LLM 容易忽略失忆状态
- vec_memories 和 session history 格式相同，模型易混淆时间线
- ACTIVE_RECALL 与 memory_status 内容重复
```

---

## 三、当前版本：buildJarvisPreamble() + 注入顺序优化

**代码**（`agent.ts`）：

```typescript
const defaultInstruction = buildJarvisPreamble();
```

### System Instruction 完整构成

```
┌─────────────────────────────────────────────────────────────┐
│  ① buildJarvisPreamble() 输出                               │
│                                                             │
│  "You are Jarvis, a deeply personalized AI assistant..."    │
│                                                             │
│  # Core Mandates                                            │
│    ## Security & System Integrity（凭证保护、不自动 commit） │
│    ## Context Efficiency（核心原则：并行、减少轮次）          │
│    ## Tool Usage（并行/顺序、文件编辑冲突、Shell 规则、确认） │
│    ## Memory（recall_memory / saveFact Jarvis 专属规则）     │
│    ## Tone & Style（简洁、Markdown、工具用于行动）            │
│                                                             │
│  注：GEMINI.md 不再加载（Gemini CLI 全局配置与 Jarvis 无关） │
│                                                             │
│  估计 token 数：300 - 600 tokens                            │
├─────────────────────────────────────────────────────────────┤
│  ② JARVIS OPERATIONAL FRAMEWORK v4.0                        │
│                                                             │
│  ## I. EXECUTION CONTEXT（首因 — 开头奠定基调）             │
│                                                             │
│     <memory_status>                                         │
│     [CRITICAL_LIMITATION]: Long-term memory is currently   │
│     offline. Do not reference past events unless they       │
│     appear in <persistent_context> or                       │
│     <relevant_past_conversations>. Call 'recall_memory'     │
│     first. DO NOT HALLUCINATE.                              │
│     </memory_status>                                        │
│                                                             │
│     <persistent_context>                                    │
│       [IDENTITY] facts（首因，排在最前）                    │
│       [BEHAVIOR] / [SPECIFICATION] / [INSIGHT] facts        │
│     </persistent_context>                                   │
│                                                             │
│     <relevant_past_conversations>                           │
│       [Long-term Memory 1]: User: ... \nAssistant: ...      │
│       [Long-term Memory 2]: ...                             │
│     </relevant_past_conversations>                          │
│                                                             │
│  ## II. OPERATIONAL PROTOCOLS（动态注入）                   │
│     1. TOOL_USE_ATOMICITY（始终）                           │
│     2. CODE_MODIFICATION_PROTOCOL（含代码关键词时）          │
│     3. PUSH_TO_CHANNEL（含推送关键词时）                     │
│     4. TASK_MANAGEMENT（含任务关键词时）                     │
│     5. TASK_DECOMPOSITION（始终）                           │
│     6. SKILL_ACTIVATION（有 skill 时）                      │
│     注：ACTIVE_RECALL 已合并入 memory_status，不再重复      │
│                                                             │
│  ## III. OUTPUT CONSTRAINTS（近因 — 末尾最后通牒）          │
│     - Role & Tone（JARVIS: deterministic, precise）         │
│     - Response Formatting（Markdown、表格、代码路径）        │
│     - <style_constraints>（preference facts + 推断风格）    │
│                                                             │
│  估计 token 数：400 - 1200 tokens                           │
└─────────────────────────────────────────────────────────────┘

总计估算：700 - 1800 tokens / 轮
```

---

## 四、精简前后对比

| 部分                     | 精简前                         | 当前版本                     |
| ------------------------ | ------------------------------ | ---------------------------- |
| 角色定义                 | "You are Gemini CLI..."        | "You are Jarvis..."          |
| Security                 | ✅ 完整                        | ✅ 完整                      |
| Context Efficiency       | 详细 + examples（~500 tokens） | 核心原则（~50 tokens）       |
| Engineering Standards    | ✅（~800 tokens）              | ❌ 去掉                      |
| Sub-Agents               | ✅                             | ❌ 去掉                      |
| Primary Workflows        | ✅（~600 tokens）              | ❌ 去掉                      |
| Tool Usage               | ✅                             | ✅ 精简保留                  |
| Shell 规则               | ✅                             | ✅ 保留                      |
| 记忆工具规则             | Gemini CLI（save_memory）      | Jarvis 专属（recall_memory） |
| Tone & Style             | ✅                             | ✅ 保留                      |
| Plan Mode / Task Tracker | ✅                             | ❌ 去掉                      |
| Sandbox / Git            | ✅                             | ❌ 去掉                      |
| GEMINI.md                | ✅ 加载                        | ❌ 不加载                    |
| memory_status 标签       | `[STRICT]`                     | `[CRITICAL_LIMITATION]`      |
| ACTIVE_RECALL 协议       | 单独一条                       | 合并入 memory_status         |
| identity facts 位置      | 散落在 persistent_context      | 置顶（首因效应）             |
| vec_memories 标签        | `[Past N]`                     | `[Long-term Memory N]`       |
| Formatting 位置          | 中间（被 prewarm 压住）        | 末尾（近因效应）             |
| **Preamble token**       | **3000 - 5000**                | **300 - 600**                |
| **总 system prompt**     | **3500 - 7100**                | **700 - 1800**               |
| **节省**                 | —                              | **~75%**                     |

---

## 五、注入顺序设计原理

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
| 中间（塌陷区） | relevant_past_conversations + protocols                                  | 数据填充，LLM 会读但注意力较低                 |
| 末尾（近因）   | OUTPUT CONSTRAINTS（Role + Formatting + style）                          | 最后通牒，生成响应前看到的最后内容，遵循率最高 |

---

## 六、注意事项

1. **JARVIS OPERATIONAL FRAMEWORK 每轮重建**：`buildFromFacts()` 在每次 `refreshContext()` 时调用，facts 和 prewarm 内容随查询变化，protocols 由 `selectProtocols(userPrompt)` 动态决定。

2. **Conversation History 只在启动时注入一次**：`agentInitializer.resumeFromDisk()` 在启动时把 session summary + 最近 N 轮原始消息通过 `client.resumeChat()` 设置为初始历史，之后由 Gemini CLI 的 `ChatRecordingService` 自动追加新消息。

3. **[Long-term Memory] vs Session History 区分**：`<relevant_past_conversations>` 里的内容标记为 `[Long-term Memory N]`，与 conversation history 里的当前 session 消息在格式上明确区分，减少模型时间线混淆。

4. **ACTIVE_RECALL 不再单独出现**：recall_memory 的使用规则已合并到 `<memory_status>` 的 `[CRITICAL_LIMITATION]` 标签里，避免重复。
