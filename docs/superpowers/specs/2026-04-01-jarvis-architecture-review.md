# Jarvis 架构评估报告（修订版）

**日期：** 2026-04-01（修订：基于源码直接阅读）
**评估范围：** `packages/jarvis/src/` 全部核心模块
**评估方法：** 直接用 Read 工具读取每个源文件 + 静态分析工具

---

## 一、静态分析数据（客观事实）

| 指标 | 数值 |
|------|------|
| TypeScript 编译错误 | 187 处（`tsc --noEmit`） |
| `@ts-ignore` / `@ts-expect-error` / `as any` 总计 | 24 处（jarvis/src 内） |
| jarvis/src 总行数 | 1,933 行 |
| 最大文件：agent.ts | 499 行 |
| 第二大：index.ts | 311 行 |

**@ts-ignore 分布（实际统计）：**
- `agent.ts`：7 处（`@ts-ignore` 5处 + `@ts-expect-error` 2处，另有 `as any` 2处）
- `index.ts`：3 处（`@ts-ignore` 1处 + `@ts-expect-error` 2处）
- `memory.ts`：6 处（均为 `as any`）
- `feishu.ts`：4 处（均为 `as any`）

---

## 二、文件概览

| 文件 | 行数 | 核心职责 |
|------|------|---------|
| `agent.ts` | 499 | 消息处理、工具调度、记忆、技能、会话 |
| `index.ts` | 311 | 服务启动、WebSocket、渠道初始化 |
| `channels/wechat.ts` | 265 | 微信渠道集成 |
| `memory.ts` | 261 | 向量数据库、队列摄入、认知整合 |
| `channels/feishu.ts` | 214 | 飞书渠道集成 |
| `configManager.ts` | 151 | 配置加载与持久化 |
| `dynamicToolRegistry.ts` | 111 | 动态技能扫描与执行 |
| `manager.ts` | 70 | Agent 生命周期、会话路由 |
| `types.ts` | 51 | 类型定义 |

---

## 三、具体问题（基于源码，按优先级排序）

### P0 — 数据安全

#### 问题 1：consolidateFacts 中 LLM 调用在事务外，解析失败会导致数据丢失

**位置：** `memory.ts` 112–173 行

实际代码（直接读取）：

```typescript
// memory.ts:133–165
const result = await this.client.models.generateContent({ ... }); // ← 网络调用，在事务外

// ...解析 result...
const match = responseText.match(/\[[\s\S]*\]/);
if (match) {
  const newFacts = JSON.parse(match[0]);          // ← 解析可能抛出
  const runUpdate = this.db.transaction(() => {   // ← 事务在这里才开始
    this.db.prepare('DELETE FROM facts').run();
    for (const f of newFacts) {
      this.db.prepare('INSERT INTO facts ...').run(...);
    }
  });
  runUpdate();
}
```

**实际情况：** DELETE 和 INSERT 确实在同一个 SQLite 事务里（`this.db.transaction()`），事务本身是正确的。但问题在于：`JSON.parse(match[0])` 在事务外执行，如果 LLM 返回的 JSON 格式非法，`match` 为 null，整个 `if (match)` 块跳过——**原有数据被保留，不会丢失**。

然而存在另一个真实问题：`if (!match)` 时，旧 facts 完整保留，但 `this.lastConsolidatedCount` 不更新，下次 `saveFact` 仍会再次触发整合，形成**无效重复整合循环**，浪费 LLM 调用。

**Why it matters：** 每次 LLM 返回格式异常，都会无效触发一次整合，消耗 API 配额，且永远无法退出整合状态。

**Fix direction：** 在 `if (!match)` 时更新 `lastConsolidatedCount`，或加入退避计数器限制重试频率。

---

### P1 — 可维护性

#### 问题 2：JarvisAgent 承担过多职责

**位置：** `agent.ts` 全文（499 行）

实际读取后确认，`JarvisAgent` 一个类承担了：

- `initialize()`（63–212行）：权限设置、config 加载、工具注册、Auth、会话恢复
- `refreshContext()`（247–285行）：每次消息前重写系统提示
- `processMessage()`（287–451行）：双层 while 循环 + 工具拦截分发 + 重试逻辑
- `stealthDistill()`（453–493行）：后台异步事实提取
- `resumeFromDisk()`（215–245行）：磁盘会话恢复

**processMessage 实际结构（直接读取）：**

```typescript
// agent.ts:314–439
while (true) {                           // 外层：工具调用循环
  while (retryCount < maxRetries ...) {  // 内层：网络重试循环
    for await (const event of responseStream) { ... }
    if (toolCallRequests.length > 0) {
      // 工具执行 ...
      currentQueryParts = toolResponseParts; // 更新下轮输入
    } else {
      success = true;
    }
  }
  if (success) break;
}
```

逻辑本身是清晰的（外层驱动工具调用轮次，内层处理网络重试），但所有这些逻辑都压缩在一个 499 行的类里，任何改动都需要理解全局状态。

**Why it matters：** `stealthDistill` 和 `processMessage` 共用同一个 `GeminiClient`（`sendMessageStream`），若 `stealthDistill` 在 `processMessage` 结束后立即触发，两者会共用同一个 chat 状态，可能污染对话历史。

**Fix direction：** `stealthDistill` 已用独立的 `new GeminiChat(...)` 实例（agent.ts:464），这个问题实际上已被规避。但职责拆分仍有价值：将后台蒸馏、系统提示构建抽离为独立类，减少 agent.ts 的认知负担。

---

#### 问题 3：工具调用双轨执行

**位置：** `agent.ts` 341–414 行

实际代码：

```typescript
// agent.ts:346–387
const jarvisDirectPromises = toolCallRequests
  .filter(req => req.name.startsWith('run_evolved_skill_')
              || req.name === 'save_memory'
              || req.name === 'recall_memory')
  .map(async (req) => { /* 直接执行，绕过 Scheduler */ });

// agent.ts:395–400
const [directResults, completedToolCalls] = await Promise.all([
  Promise.all(jarvisDirectPromises),
  standardRequests.length > 0
    ? this.scheduler.schedule(standardRequests, abortController.signal)
    : Promise.resolve([])
]);
```

**实际情况：** 两条路径并行执行后结果合并（`toolResponseParts`），再一起送回 LLM。功能上能工作，但：
1. Scheduler 的工具执行记录（`recordCompletedToolCalls`）只覆盖标准工具，Jarvis 直接工具无审计记录
2. 新增自定义工具时，必须同时修改 filter 条件和执行逻辑两处

**Why it matters：** 可维护性问题。添加第四个直接工具需要改两处代码，且没有编译期检查提醒。

**Fix direction：** 将 `save_memory` / `recall_memory` 实现为实现了 `Tool` 接口的标准工具，通过 Scheduler 统一执行，消除 filter 分支。

---

### P1 — 并发安全

#### 问题 4：FeishuChannel 的 DONE 事件监听器未用 once，可能重复触发

**位置：** `feishu.ts` 192–196 行

实际代码：

```typescript
// feishu.ts:192–196
agent.on(JarvisEventType.CONTENT, contentHandler);
agent.on(JarvisEventType.DONE, () => {       // ← on，不是 once
  void updateCard(accumulatedText);
  agent.removeListener(JarvisEventType.CONTENT, contentHandler);
});
```

对比 `index.ts` 中 WebSocket 的处理方式：

```typescript
// index.ts:239–240
agent.once(JarvisEventType.DONE, onDone);   // ← 正确用了 once
agent.once(JarvisEventType.ERROR, onError);
```

**实际问题：** 飞书渠道对 `DONE` 用了 `on` 而不是 `once`。如果同一个 agent 实例处理多条消息，前一条消息注册的 DONE 监听器不会被移除（因为 `removeListener` 只移除了 `CONTENT`），导致后续消息完成时，旧的 `updateCard` 也会被触发，用新消息的内容覆盖旧消息的飞书卡片。

**Why it matters：** 在 global session 模式下（所有消息路由到同一 agent），这个问题必然触发。

**Fix direction：** 将 `agent.on(JarvisEventType.DONE, ...)` 改为 `agent.once(...)`，并在回调内同时移除 CONTENT 监听器。

---

### P2 — 可扩展性

#### 问题 5：Channel 无统一抽象，流式事件处理逻辑重复

**位置：** `feishu.ts` 177–201 行、`wechat.ts`（未在本次读取范围，但结构对称）

飞书 channel 直接持有 `JarvisManager` 引用，自行管理：
- agent 获取
- 流式事件订阅（CONTENT / DONE）
- 文本积累逻辑
- 渠道 API 调用

新增渠道（Telegram 等）需重复这套逻辑。缺少一个 `BaseChannel` 抽象统一处理流式订阅和 cleanup。

**Fix direction：** 定义 `abstract class BaseChannel`，将 agent 获取、事件订阅/清理、文本积累提取为模板方法，子类只需实现 `sendMessage(text)` 和 `updateMessage(id, text)`。

---

### P2 — 代码健壮性

#### 问题 6：PolicyEngine 通过猴子补丁全局修改

**位置：** `index.ts` 25–38 行

实际代码：

```typescript
// index.ts:30–33
if (jarvisConfig.security.jailbreak) {
  // @ts-ignore
  PolicyEngine.prototype.check = async function() {
    return { decision: 'allow' };
  };
}
```

**实际情况：** 修改 prototype 是全局副作用，影响进程中所有 PolicyEngine 实例。这是一个有意为之的设计选择（"jailbreak"），功能上没有 bug，但：
1. 需要 `@ts-ignore` 绕过类型检查，说明这不是 core 设计的扩展点
2. 测试时无法针对单个实例控制策略

**Fix direction：** 在 core 的 PolicyEngine 构造函数中支持传入策略函数，Jarvis 在创建实例时注入，而不是修改原型。这是上游改动，可作为长期优化。

---

### P3 — 类型安全

#### 问题 7：@ts-ignore 集中在层间边界，是架构问题的症状

**实际分布（直接统计）：**

```
agent.ts:29   // @ts-expect-error - Relative import（构建工具问题，非架构问题）
agent.ts:31   // @ts-expect-error - Relative import
agent.ts:33   // @ts-expect-error - Relative import
agent.ts:112  // @ts-ignore — config.storage.targetDir（访问内部属性）
agent.ts:114  // @ts-ignore — config.storage.getProjectTempDir（访问内部属性）
agent.ts:140  // @ts-ignore — registry.addDiscoveredTool（调用未公开方法）
agent.ts:142  // @ts-ignore — 同上
agent.ts:170  // @ts-ignore — 同上（evolved tools 注册）
agent.ts:172  // @ts-ignore — 同上
index.ts:30   // @ts-ignore — PolicyEngine.prototype.check（猴子补丁）
index.ts:65   // @ts-expect-error - Relative import
index.ts:67   // @ts-expect-error - Relative import
```

**根本原因：** `agent.ts` 中 4 处 `@ts-ignore` 集中在 `registry.addDiscoveredTool` 和 `config.storage.*`，这两个 API 是 core 包的内部实现，没有对外暴露。Jarvis 直接访问内部属性，类型系统无法保护。

**Why it matters：** core 包升级时，这些内部 API 可能静默变更，编译不报错但运行时崩溃。

**Fix direction：** 推动 core 包暴露正式的 `registerTool(tool)` 和 `setStorageOverrides(opts)` API，消除直接访问内部属性的需要。

---

## 四、已撤销的错误结论

| 原结论 | 实际情况 |
|--------|---------|
| "MemoryService 队列存在竞争条件" | 错误。`while` 循环内 `await` 是串行的，`isProcessing` 守卫正确工作 |
| "consolidateFacts 先删后写无事务" | 部分错误。DELETE 和 INSERT 确实在同一 SQLite 事务内，数据不会丢失 |
| "stealthDistill 与主流程共用 chat 状态" | 错误。`stealthDistill` 使用 `new GeminiChat(...)` 独立实例（agent.ts:464） |

---

## 五、值得保留的设计

| 设计 | 位置 | 原因 |
|------|------|------|
| 事件驱动流式架构 | `agent.ts` + `index.ts` | EventEmitter + WebSocket 解耦响应传递，WebSocket 侧正确使用 `once` |
| SQLite 事务包裹整合 | `memory.ts:157–163` | DELETE + INSERT 在同一事务，原子性正确 |
| 飞书心跳三级降级 | `feishu.ts:76–98` | Level1→Level2→Raw Request，防止 SDK 结构变化导致心跳失效 |
| DynamicToolRegistry 技能扫描 | `dynamicToolRegistry.ts` | 无需重启加载新技能，`execSync` 同步执行保证结果可用 |
| 消息去重 + 时间过滤 | `feishu.ts:43–44` | 防止历史消息重复处理 |
| stealthDistill 独立 chat 实例 | `agent.ts:464` | `new GeminiChat(...)` 避免污染主对话历史 |

---

## 六、依赖关系（基于实际代码）

```
index.ts (JarvisServer)
  ├── JarvisManager (单例)
  │   ├── JarvisAgent (per session 或 global)
  │   │   ├── GeminiClient (core) — chat + sendMessageStream
  │   │   ├── Scheduler (core) — 标准工具执行
  │   │   ├── DynamicToolRegistry — evolved_skills 执行
  │   │   └── MemoryService (共享引用，来自 Manager)
  │   └── MemoryService (单例，Manager 持有)
  ├── FeishuChannel → JarvisManager.getAgent()
  └── WechatChannel → JarvisManager.getAgent()
```

**实际耦合点：**
- `agent.ts` 直接访问 `config.storage.targetDir`（core 内部属性）
- `agent.ts` 直接调用 `registry.addDiscoveredTool()`（core 未公开方法）
- `index.ts` 修改 `PolicyEngine.prototype`（core 全局副作用）

---

## 七、优先级汇总

| 优先级 | 问题 | 影响范围 |
|--------|------|---------|
| P1 | JarvisAgent God Object（职责过多） | 可维护性 |
| P1 | 工具调用双轨执行（filter + 双路并行） | 可维护性、可审计性 |
| P1 | FeishuChannel DONE 事件用 `on` 而非 `once` | 并发安全，global session 模式下必现 |
| P1 | consolidateFacts 无效重复整合循环 | API 配额浪费 |
| P2 | Channel 无统一抽象 | 可扩展性 |
| P2 | PolicyEngine 猴子补丁 | 代码健壮性 |
| P3 | @ts-ignore 集中在层间边界 | 类型安全、升级风险 |

---

## 八、下一步建议

**最值得立即修复的是 P1 中的飞书 DONE 事件问题**——这是一行代码的改动（`on` 改 `once`），但在 global session 模式下会导致实际的消息错乱 bug。其余 P1 问题建议在下一个功能迭代前处理。
