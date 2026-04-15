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

## 二、精简前：使用 getCoreSystemPrompt()

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
│       - 凭证保护、不自动 commit                              │
│    ## Context Efficiency                                    │
│       - 详细搜索/读取策略 + <guidelines> + <examples>       │
│    ## Engineering Standards                                 │
│       - 代码规范、类型安全、测试要求、Directive/Inquiry 区分  │
│       - 不得禁用 linter、不得随意 revert 等                  │
│                                                             │
│  # Available Sub-Agents                                     │
│    - 列出所有可用子 Agent 及调用规则                         │
│                                                             │
│  # Agent Skills                                             │
│    - Skill 列表及激活规则                                    │
│                                                             │
│  # Primary Workflows                                        │
│    - 工具使用工作流（shell/read/edit/grep 详细规则）          │
│    - 代码编辑工作流                                          │
│    - Plan Mode 规则                                         │
│                                                             │
│  # Operational Guidelines                                   │
│    ## Tone & Style                                          │
│    ## Security and Safety Rules（Shell 命令解释）            │
│    ## Tool Usage（并行、文件编辑冲突、确认协议）              │
│    ## Interaction Details                                   │
│                                                             │
│  # Sandbox / Git                                            │
│    - macOS Seatbelt 或容器沙箱规则                          │
│    - Git 仓库相关规则                                        │
│                                                             │
│  GEMINI.md（userMemory，renderFinalShell 追加）             │
│    - ~/.gemini/gemini.md（全局用户自定义指令）               │
│    - 项目目录下的 GEMINI.md（项目级指令）                    │
│                                                             │
│  估计 token 数：3000 - 5000 tokens                          │
├─────────────────────────────────────────────────────────────┤
│  ② JARVIS OPERATIONAL FRAMEWORK v4.0                        │
│     buildFromFacts() 生成                                   │
│                                                             │
│  ## I. CORE PROTOCOLS (MANDATORY)                           │
│     1. TOOL_USE_ATOMICITY          ← 始终注入               │
│     2. CODE_MODIFICATION_PROTOCOL  ← 含代码关键词时注入     │
│     3. PUSH_TO_CHANNEL             ← 含推送关键词时注入     │
│     4. TASK_MANAGEMENT             ← 含任务关键词时注入     │
│     5. TASK_DECOMPOSITION          ← 始终注入               │
│     6. ACTIVE_RECALL (MANDATORY)   ← 始终注入               │
│     7. SKILL_ACTIVATION            ← 有可用 skill 时注入    │
│                                                             │
│  ## II. EXECUTION CONTEXT                                   │
│     <persistent_context>                                    │
│       alwaysFacts（preference + insight）                   │
│       ranked facts（top N，融合分数排序）                    │
│       graph expanded facts（最多3条）                        │
│     </persistent_context>                                   │
│     <memory_status>                                         │
│     <style_constraints>                                     │
│                                                             │
│  ## III. ROLE & TONE                                        │
│  ## IV. RESPONSE FORMATTING                                 │
│                                                             │
│  估计 token 数：500 - 1500 tokens（随 facts 数量变化）       │
├─────────────────────────────────────────────────────────────┤
│  ③ <relevant_past_conversations>                            │
│     vec_memories 向量检索，最多 prewarmLimit 条（默认 3）    │
│     估计 token 数：0 - 600 tokens                           │
└─────────────────────────────────────────────────────────────┘

总计估算：3500 - 7100 tokens / 轮
```

---

## 三、精简后：使用 buildJarvisPreamble()

**代码**（`agent.ts`）：

```typescript
const userMemory = this.client.config.getUserMemory();
const userMemoryStr = typeof userMemory === "string" ? userMemory : "";
const defaultInstruction = buildJarvisPreamble(userMemoryStr);
```

### System Instruction 完整构成

```
┌─────────────────────────────────────────────────────────────┐
│  ① buildJarvisPreamble() 输出                               │
│                                                             │
│  "You are Jarvis, a deeply personalized AI assistant..."    │
│                                                             │
│  # Core Mandates                                            │
│    ## Security & System Integrity                           │
│       - 凭证保护、不自动 commit（保留原版）                   │
│    ## Context Efficiency                                    │
│       - 核心原则：并行工具调用，减少不必要轮次（精简版）      │
│       - 去掉：详细 <guidelines>、<examples>                 │
│    ## Tool Usage                                            │
│       - 并行/顺序执行规则                                    │
│       - 同文件不重复 edit                                    │
│       - Shell 命令执行规则                                   │
│       - 后台进程 / 非交互命令偏好                            │
│       - 确认协议                                             │
│    ## Memory                                                │
│       - recall_memory：过去交互必须先召回（Jarvis 工具）     │
│       - saveFact：自动提炼，无需手动保存                     │
│    ## Tone & Style                                          │
│       - 简洁直接，避免寒暄                                   │
│       - GitHub-flavored Markdown                            │
│       - 工具用于行动，文字用于沟通                           │
│                                                             │
│  GEMINI.md（userMemory，直接追加在末尾）                    │
│                                                             │
│  估计 token 数：400 - 800 tokens                            │
├─────────────────────────────────────────────────────────────┤
│  ② JARVIS OPERATIONAL FRAMEWORK v4.0（与精简前相同）        │
│     估计 token 数：500 - 1500 tokens                        │
├─────────────────────────────────────────────────────────────┤
│  ③ <relevant_past_conversations>（与精简前相同）            │
│     估计 token 数：0 - 600 tokens                           │
└─────────────────────────────────────────────────────────────┘

总计估算：900 - 2900 tokens / 轮
```

---

## 四、精简对比

| 部分                            | 精简前                             | 精简后                                |
| ------------------------------- | ---------------------------------- | ------------------------------------- |
| 角色定义                        | "You are Gemini CLI..."            | "You are Jarvis..."                   |
| Security                        | ✅ 完整保留                        | ✅ 完整保留                           |
| Context Efficiency              | 详细规则 + examples（~500 tokens） | 核心原则（~50 tokens）                |
| Engineering Standards           | ✅ 包含（~800 tokens）             | ❌ 去掉                               |
| Sub-Agents                      | ✅ 包含                            | ❌ 去掉                               |
| Primary Workflows               | ✅ 包含（~600 tokens）             | ❌ 去掉                               |
| Tool Usage                      | ✅ 包含                            | ✅ 保留（精简）                       |
| Shell 规则                      | ✅ 包含                            | ✅ 保留                               |
| 记忆工具规则                    | Gemini CLI 原生（save_memory）     | Jarvis 专属（recall_memory/saveFact） |
| Tone & Style                    | ✅ 包含                            | ✅ 保留                               |
| Plan Mode / Task Tracker        | ✅ 包含                            | ❌ 去掉                               |
| Sandbox / Git                   | ✅ 包含                            | ❌ 去掉                               |
| GEMINI.md                       | ✅ 通过 renderFinalShell 追加      | ✅ 直接追加                           |
| **估计 token（Preamble 部分）** | **3000 - 5000**                    | **400 - 800**                         |
| **总 system prompt token**      | **3500 - 7100**                    | **900 - 2900**                        |
| **节省**                        | —                                  | **~70%**                              |

---

## 五、注意事项

1. **JARVIS OPERATIONAL FRAMEWORK 未变**：`buildFromFacts()` 生成的部分（protocols、facts 注入、role/tone、formatting）保持不变，`selectProtocols` 仍然根据用户输入关键词动态决定注入哪些协议。

2. **GEMINI.md 仍然加载**：`buildJarvisPreamble(userMemoryStr)` 接收 userMemory 并追加在末尾，全局和项目级 GEMINI.md 内容不受影响。

3. **代码编辑能力未丧失**：工具使用规则（edit、shell 等）保留，只是去掉了面向软件工程任务的详细工作流说明。LLM 仍然知道如何调用这些工具。

4. **测试建议**：精简后需验证工具调用（特别是文件编辑）是否仍然正确，以及 recall_memory 是否在适当时机触发。
