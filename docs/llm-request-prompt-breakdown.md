# Jarvis LLM 请求与 Prompt 构成详解

这份文档专门回答一个问题：

> Jarvis 每次和后端 LLM 交互时，实际发过去的内容到底由哪些部分组成？

这里的“prompt”不是单一字符串，而是一整个请求对象。当前实现里，一次 LLM 请求主要由四部分构成：

1. `model`
2. `systemInstruction`
3. `contents`
4. `tools / toolConfig`

代码主入口：

- [jarvis/src/core/agent.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/agent.ts)
- [jarvis/src/core/systemPromptBuilder.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/systemPromptBuilder.ts)
- [gemini-cli/packages/core/src/core/geminiChat.ts](/Users/lw/opensource/jarvis-personal-ai/gemini-cli/packages/core/src/core/geminiChat.ts)

## 一、总结构

可以把一次实际请求抽象成这个公式：

```text
LLM Request
= selected model
+ systemInstruction
+ contents(history + current turn parts)
+ tools / toolConfig
+ hooks possible rewrites
```

更具体一点：

```text
systemInstruction
= Jarvis base preamble
+ memory_status
+ persistent_context (facts)
+ operational protocols
+ output constraints
+ style_constraints
+ relevant_past_conversations

contents
= prior chat history
+ current user message
or
+ tool functionResponse parts
```

## 二、真正发请求的代码路径

主链路在 `JarvisAgent.processMessage()`：

1. 做本地路由，决定模型、查询主题、时间窗
2. 调 `refreshContext()` 重建 `systemInstruction`
3. 组当前轮输入 `currentQueryParts`
4. 调 `client.sendMessageStream(...)`
5. 如果模型发出 tool call，则执行工具
6. 把工具结果作为新的 `currentQueryParts` 再送回模型

关键位置：

- `refreshContext()`：重建 system prompt
- `currentQueryParts`：当前轮发给模型的 parts
- `toolRouter.route(...)`：把工具结果变成 functionResponse parts

## 三、System Instruction 的详细构成

当前每轮在 `refreshContext()` 里执行：

```ts
const protocol = this.promptBuilder.buildFromFacts(
  facts,
  userPrompt,
  relevantSkills,
);
const defaultInstruction = buildJarvisPreamble();
this.client
  .getChat()
  .setSystemInstruction(defaultInstruction + "\n" + protocol + prewarmSection);
```

所以 `systemInstruction` 是三段拼接：

1. `buildJarvisPreamble()`
2. `buildFromFacts(...)`
3. `prewarmSection`

### 1. Base Preamble

来源：

- [jarvis/src/core/systemPromptBuilder.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/systemPromptBuilder.ts)

这部分是 Jarvis 的固定底座，包含：

- 角色定义：`You are Jarvis, a deeply personalized AI assistant`
- 当前日期：每轮实时注入，避免长会话日期漂移
- 安全要求
- 上下文成本意识
- 工具使用原则

实际包含的核心约束大致是：

- 不泄露 secrets，不乱动 `.env`
- 未经用户要求不要 commit
- 尽量减少无效轮次
- 优先并行独立工具调用
- 修改系统状态前先简要说明
- 同一轮不要对同一文件多次编辑
- 工具调用被拒绝后不要强行重试

### 2. `buildFromFacts(...)`

这部分是每轮动态变化的主体框架，最终产出的标题是：

```text
# JARVIS OPERATIONAL FRAMEWORK v4.0
```

它可以拆成三层。

#### I. EXECUTION CONTEXT

这一层主要由 `memory_status` 和 `persistent_context` 构成。

##### `memory_status`

这一段不是具体记忆，而是“如何正确使用记忆”的规则：

- 长期记忆不是整库预加载的
- 不允许凭空引用过去事件
- 用户问过去聊过什么时，先看 `<relevant_past_conversations>`
- 不够时再调用 `recall_memory`
- `save_memory` 不该滥用，用户明确要求“记住”才手调

它本质上是在约束模型不要编造“我们以前说过”。

##### `persistent_context`

这里塞的是从长期记忆检索出来的 facts。

来源：

- `memoryService.searchFacts(...)`

注入策略：

- `querySubject !== "external"` 才会查 facts
- `external` 查询直接跳过 personal facts 注入
- `personal/mixed` 查询会对检索 query 加前缀：

```text
PRIVATE_USER_DATA: User Query - ${userPrompt}
```

当前注入的 facts 大致分为：

- `identity`
- `interaction_style`
- 其他非 identity 的 persistent facts

但注意：

- `identity` 和普通 facts 进 `<persistent_context>`
- `interaction_style` 不在这里展示，而是进后面的 `<style_constraints>`

#### II. OPERATIONAL PROTOCOLS

这一层是行为协议。

始终会有：

- `TOOL_USE_ATOMICITY`
- `TASK_DECOMPOSITION`

按用户当前问题是否命中关键词，动态注入：

- `CODE_MODIFICATION_PROTOCOL`
- `PUSH_TO_CHANNEL`
- `TASK_MANAGEMENT`

如果当前相关 skills 非空，还会注入：

- `SKILL_ACTIVATION`
- `<available_skills> ... </available_skills>`

这意味着 system prompt 不是一份固定模板，而是会根据当前用户问题启发式切换协议集。

#### III. OUTPUT CONSTRAINTS

这一层放在最后，明显是为了利用近因效应。

它会约束模型：

- 以 JARVIS 身份输出
- 避免 conversational fillers
- 用高密度表达
- 使用 Markdown
- 金融/数据分析用表格
- 代码回答标语言和文件路径

### 3. `style_constraints`

这部分由 `buildFromFacts(...)` 内部追加在输出约束尾部。

来源有两路：

1. 从 `identity` facts 推导用户是否偏技术背景
2. 从 `interaction_style` facts 读取用户显式偏好

结构类似：

```text
<style_constraints>
- [DEFAULT]: User is a technical professional ...
- [USER_PREFERENCE]: ...
</style_constraints>
```

规则上：

- `DEFAULT` 是基于身份推导出的默认风格
- `USER_PREFERENCE` 在冲突时优先级更高

### 4. `prewarmSection`

这一段最终直接拼在 `systemInstruction` 末尾。

来源：

- `memoryService.search(userPrompt, prewarmLimit, ...)`

格式：

```text
<relevant_past_conversations>
[Long-term Memory 1]: ...
[Long-term Memory 2]: ...
</relevant_past_conversations>
```

作用不是注入结构化 facts，而是注入少量相似历史片段。

注意：

- 只在 `querySubject !== "external"` 时注入
- 默认上限由 `memory.prewarmLimit` 控制
- 这是“相似历史回忆”，不是完整历史回放

## 四、当前真正送到模型的 System Instruction 模板

可以把当前实现近似展开成下面这样：

```text
You are Jarvis, a deeply personalized AI assistant.
Today's date is: ...

# Core Mandates
- security rules
- context efficiency rules
- tool usage rules

# JARVIS OPERATIONAL FRAMEWORK v4.0

## I. EXECUTION CONTEXT
<memory_status>
long-term memory is not fully preloaded...
first use relevant_past_conversations...
then use recall_memory if needed...
do not hallucinate...
</memory_status>

<persistent_context>
- [IDENTITY]: ...
- [BEHAVIOR]: ...
- [SPECIFICATION]: ...
- ...
</persistent_context>

## II. OPERATIONAL PROTOCOLS
- TOOL_USE_ATOMICITY
- optional CODE_MODIFICATION_PROTOCOL
- optional PUSH_TO_CHANNEL
- optional TASK_MANAGEMENT
- TASK_DECOMPOSITION
- optional SKILL_ACTIVATION

## III. OUTPUT CONSTRAINTS
- deterministic, precise, system-native
- skip fillers
- markdown formatting rules

<style_constraints>
- [DEFAULT]: ...
- [USER_PREFERENCE]: ...
</style_constraints>

<relevant_past_conversations>
[Long-term Memory 1]: ...
[Long-term Memory 2]: ...
</relevant_past_conversations>
```

这不是逐字完整拷贝，但已经对应了当前代码里的真实拼装结构。

## 五、Contents 的构成

`systemInstruction` 之外，模型每次还会收到 `contents`。

在 `GeminiChat.sendMessageStream()` 里：

1. 先把当前 user content push 进 history
2. 取 `requestContents = this.getHistory(true)`
3. 把 `requestContents` 作为真正发给模型的 `contents`

所以 `contents` 的本质是：

- 已有 chat history
- 加本轮输入

### History 里可能有哪些内容

#### 1. 普通用户消息

```text
role: user
parts: [{ text: "..." }]
```

#### 2. 模型历史回复

```text
role: model
parts: [{ text: "..." }]
```

#### 3. 工具结果回填

当模型调用工具后，工具执行结果不会只停留在程序内，而是会作为新的用户侧 function response 注回 history / request loop。

形式大致是：

```text
role: user
parts: [
  {
    functionResponse: {
      name: "tool_name",
      response: { ... }
    }
  }
]
```

#### 4. 历史摘要

当会话过长时，老 history 会被压缩成摘要，再保留最近若干 raw turns。

摘要头部格式是：

```text
[CONVERSATION HISTORY SUMMARY]
...
```

也就是说，模型看到的对话历史，不一定全是原始逐轮消息，可能是：

- 一个摘要块
- 外加最近几轮原始对话

## 六、首轮请求 vs 工具循环请求

这是最容易被忽略，但最关键的一点。

### 场景 A：正常首轮请求

第一次真正问模型时：

```text
systemInstruction = 最新重建后的 Jarvis prompt
contents = 历史消息 + 当前用户文本/图片
```

如果用户发的是纯文本，大致等价于：

```text
contents = [
  ...previous_history,
  { role: "user", parts: [{ text: userPrompt }] }
]
```

如果用户带图片：

```text
contents = [
  ...previous_history,
  {
    role: "user",
    parts: [
      { text: userPrompt },
      { inlineData: { mimeType, data } }
    ]
  }
]
```

### 场景 B：模型发出工具调用后的下一轮

如果模型先不直接回答，而是发出 tool calls：

1. Jarvis 执行工具
2. 拿到 `responseParts`
3. `currentQueryParts = responseParts`
4. 再次调用 `sendMessageStream(...)`

这时下一次发给模型的“当前轮输入”已经不是原始 `userPrompt`，而是工具结果。

也就是说，第二跳请求更接近：

```text
systemInstruction = 同一轮刚刚重建过的 Jarvis prompt
contents = 历史消息 + 本轮 functionResponse parts
```

当前轮内部的迭代过程可以写成：

```text
用户问题
-> 模型决定调工具
-> 工具结果 functionResponse
-> 模型继续推理并给最终文本
```

### 差异图

#### 1. 首轮

```text
[System Instruction]
  Jarvis preamble
  + memory/status/facts/protocols/styles/prewarm

[Contents]
  prior history
  + current user text/image
```

#### 2. 工具循环后续轮

```text
[System Instruction]
  与本轮首跳相同

[Contents]
  prior history
  + model tool call already in loop context
  + current functionResponse parts
```

关键差异只有一条：

- 首轮的新增输入是用户消息
- 工具循环后续轮的新增输入是工具返回结果

## 七、启动恢复对 Prompt 的影响

Jarvis 启动时会把历史会话恢复进 chat history。

恢复逻辑在：

- [jarvis/src/core/resumeFromDisk.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/resumeFromDisk.ts)
- [jarvis/src/core/agentInitializer.ts](/Users/lw/opensource/jarvis-personal-ai/jarvis/src/core/agentInitializer.ts)

这里有两个关键点：

1. 恢复时会把旧会话转成 `Content[]`
2. 会主动剥掉 gemini-cli 默认注入的 `<session_context>` turn

所以当前 Jarvis 的历史上下文不是“上游默认会话上下文 + Jarvis 再叠加一层”，而是刻意清理过的、更偏 Jarvis 自己控制的 history。

## 八、工具定义也属于请求的一部分

虽然这不属于 prompt 文本，但对模型行为影响非常大。

在 `GeminiChat.makeApiCallAndProcessStream()` 里，最终请求 config 会带：

- `systemInstruction`
- `tools`
- `abortSignal`
- 可能的 `toolConfig`

所以从模型视角，一次完整请求不是单纯“读一段 prompt”，而是：

- 看 system prompt
- 看历史与当前消息
- 看当前可调用的函数工具集合

这也是为什么工具 availability 的变化，会直接改变模型行为。

## 九、Hooks 还能二次改写最终请求

在 gemini-cli 层，真正出网前，hook system 还有机会改：

- `model`
- `config`
- `contents`
- `tools`

所以严格说，Jarvis 构造的是“基础请求”，最终出网请求可能再经过一次 hook 改写。

这也是调试 prompt 时需要注意的一点：

- 你在 `JarvisAgent.refreshContext()` 看到的是 Jarvis 版本
- 真正发出的内容，可能经过 gemini-cli hooks 二次处理

## 十、最终结论

当前实现不是“每轮把所有长期记忆和完整上下文生硬塞回模型”，而是：

1. 每轮重建一份动态的 `systemInstruction`
2. 只注入与当前问题相关的 facts
3. 只预热少量相似历史片段
4. 保留 chat history 作为对话连续性载体
5. 在工具循环里，把 functionResponse 作为后续推理输入

最关键的理解可以浓缩成一句话：

> Jarvis 的每次 LLM 请求 = 动态 system prompt + 会话 history + 当前输入或工具回填 + 当前可用工具集合。

## 十一、调试 Prompt 时的推荐观察点

如果后面要继续调 prompt，优先看这些位置：

- `agent.ts: refreshContext()`
  看本轮 facts / skills / prewarm 是否注入正确。
- `systemPromptBuilder.ts`
  看协议段、风格段、记忆规则段是否合理。
- `agent.ts: currentQueryParts`
  看当前发送的是用户消息，还是工具回填。
- `geminiChat.ts`
  看最终 `contents` 和 `config.systemInstruction` 是怎样送到模型的。
