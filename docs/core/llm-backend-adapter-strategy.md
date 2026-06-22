# LLM Backend Adapter Strategy

本文档描述 Jarvis 当前的 LLM backend 架构、已实现能力、配置方式、兼容边界和后续验证工作。

更严格的 Gemini CLI 解耦目标参见
`docs/core/gemini-cli-decoupling-roadmap.md`。本文聚焦模型协议与主响应执行，解耦
roadmap 还覆盖启动、配置、session、memory、policy、日志和依赖管理。

## 1. Current Assessment

Jarvis 的主响应路径已经不再以 Gemini CLI protocol 作为内部 runtime contract。

当前架构支持两条生产路径：

- `gemini`：Gemini CLI compatibility runtime；
- `openai`：OpenAI-compatible standalone runtime。

当 `llmBackend.provider=openai` 时：

- `JarvisManager` 创建 `StandaloneJarvisAgent`；
- `BackgroundTaskRunner` 创建独立的 standalone agent；
- 不构造 `GeminiClient`；
- 不加载 Gemini CLI config、PolicyEngine 或 core events；
- 主响应、streaming、tool loop、memory injection、session 写入均使用
  Jarvis-owned runtime contracts。

Gemini CLI 已成为可选 compatibility layer，不再是 standalone 主路径的隐式协议。

## 2. Target Architecture

```text
Jarvis application
  -> AgentRuntime
      -> IntentRuntime
      -> MemoryRuntime
      -> SkillRuntime
      -> ResponseComposer
      -> ToolLoopRuntime
          -> LlmBackend
          -> PromptCompiler
          -> ToolExecutorAdapter

Backend adapters
  -> Gemini compatibility adapter
  -> OpenAI-compatible adapter
  -> future Anthropic / vLLM / local adapters
```

核心设计原则：

1. Provider-specific protocol 只存在于 backend adapter 边界。
2. Streaming、retry、tool sequencing 和 completion validation 由 runtime 管理。
3. Tool schema 和执行结果使用 Jarvis-owned contracts。
4. Backend 切换不能改变 intent、memory、policy 和 execution contract。
5. 工具执行成功必须来自实际 tool result，不能接受模型自述。

## 3. Runtime Contracts

### 3.1 LlmBackend

`packages/agent-runtime` 定义 backend-neutral 主对话协议：

```ts
export type LlmBackend = {
  sendTurn(input: LlmTurnInput, signal: AbortSignal): AsyncIterable<LlmEvent>;
  getModel(): string;
  getCapabilities(): LlmBackendCapabilities;
};
```

标准事件包括：

- content delta；
- structured tool call；
- metadata；
- backend error。

Runtime 不需要知道 provider 使用 Gemini parts、OpenAI messages 还是其他 content
blocks。

### 3.2 Backend Capabilities

Backend 显式声明：

- streaming；
- native tool calling；
- JSON mode；
- multimodal input；
- context window。

Runtime 据此选择 native tool calling、deterministic execution 或未来的
text-action calling。

### 3.3 PromptCompiler

`PromptCompiler` 负责把 runtime messages 编译为 provider-specific messages：

- initial system/user messages；
- assistant tool-call message；
- tool result message；
- retry / missing-step prompt。

这层存在的原因是不同 provider 对 tool result 的消息顺序和格式要求不同，不能把
这些差异泄漏到 `AgentRuntime`。

### 3.4 Runtime Tool Contract

工具调用统一使用：

- `RuntimeToolRequest`；
- `RuntimeToolResult`；
- `LlmToolSchema`；
- `ToolExecutorAdapter`。

Jarvis 的 `RuntimeToolRegistry` 是 tool schema 的主来源。Gemini 和 OpenAI adapter
都从同一 registry 编译自己的工具声明。

当前 Jarvis-owned runtime tools 包括 memory、task、channel、ask_user，以及
Gemini CLI 迁移出来的 workspace 工具：

- `read_file`
- `write_file`
- `read_many_files`
- `glob`
- `grep`
- `run_shell_command`

这些 workspace 工具由 `WorkspaceTools` 在 Jarvis runtime 层执行，路径被限制在当前
workspace root 内，并带有基础安全策略，例如敏感文件读取阻断、路径逃逸阻断、shell
危险命令阻断、timeout 和输出截断。

这样设计的原因是：文件读写、搜索和 shell 是 agent 的基础能力，不能继续只存在于
Gemini CLI scheduler 中。OpenAI-compatible backend 必须能消费同一套 Jarvis-owned
tool schema 和 executor。Gemini compatibility path 会继续保留 Gemini CLI 自身的同名
工具声明；`addToolsToGeminiRegistry()` 会跳过这些 workspace 同名工具，避免覆盖或重复注册。

## 4. Implemented Components

### Agent Runtime

`packages/agent-runtime` 已实现：

- `AgentRuntime.handleTurn()`；
- `RuntimeContext`；
- `ResponseComposer`；
- `ToolLoopRuntime`；
- `ToolLoopPlanner`；
- retry 和 retry exhaustion；
- tool iteration guard；
- consecutive tool failure guard；
- deterministic multi-intent enforcement；
- missing-step enforcement；
- final completion contract。

### OpenAI-Compatible Backend

`OpenAiChatCompletionsBackend` 已支持：

- Chat Completions streaming；
- content delta；
- streaming tool-call accumulation；
- runtime tool schema 编译；
- assistant tool-call 与 tool-result message 编译；
- OpenAI、vLLM 和兼容网关的 `baseUrl` 配置；
- timeout、API key、organization 和 project 配置。

OpenAI-compatible backend 是当前 standalone 主对话实现。

### Gemini Compatibility Backend

Gemini compatibility 代码集中在显式的 `gemini*` 文件中：

- `geminiAgent.ts`；
- `geminiAgentInitializer.ts`；
- `geminiBackendAdapter.ts`；
- `geminiRuntimeAdapter.ts`；
- `geminiLlmBackendFactory.ts`。

Adapter 负责：

- Gemini `sendMessageStream()` 转为 `LlmEvent`；
- Gemini tool call 转为 `RuntimeToolRequest`；
- `RuntimeToolResult` 转为 Gemini `functionResponse`；
- runtime messages 转为 Gemini parts。

Gemini CLI config、PolicyEngine 和 core events 只在 compatibility mode 动态加载。

### Standalone Agent

`StandaloneJarvisAgent` 已接入：

- OpenAI-compatible backend；
- `AgentRuntime` / `ToolLoopRuntime`；
- intent routing；
- memory contract、retrieval 和 injection；
- Jarvis tool registry；
- `ToolRouter`；
- task、push、memory recall、ask_user；
- Jarvis-native workspace tools：`read_file`、`write_file`、`read_many_files`、`glob`、`grep`、`run_shell_command`；
- multi-intent step runtime；
- Jarvis JSONL session transcript；
- background task isolation。

Standalone runtime 不使用 Gemini CLI scheduler。未注册的非 native tool 会返回明确的
失败结果，而不是静默模拟成功。

### Single-Call Generation

`TextGenerationBackend` 用于不需要主 tool loop 的流程：

- text generation；
- JSON generation；
- timeout；
- retry；
- JSON repair；
- backend metadata。

Intent resolver 可以通过 `IntentModelClient` 使用 Ollama 或
OpenAI-compatible model。主对话 backend 与 routing、summarizer、reflection、
embedding provider 相互独立。

## 5. Configuration

### Gemini Compatibility

```json
{
  "llmBackend": {
    "provider": "gemini"
  }
}
```

Gemini 是当前默认值，使用 Gemini CLI authentication 和 compatibility tools。

### OpenAI-Compatible Standalone

```json
{
  "llmBackend": {
    "provider": "openai",
    "openai": {
      "apiKeyEnv": "OPENAI_API_KEY",
      "model": "gpt-4.1",
      "baseUrl": "https://api.openai.com/v1",
      "timeoutMs": 120000
    }
  },
  "routing": {
    "targets": {
      "pro": "gpt-4.1",
      "flash": "gpt-4.1-mini"
    }
  }
}
```

通过环境变量提供密钥：

```bash
export OPENAI_API_KEY="..."
npm start
```

OpenAI-compatible gateway 或 vLLM 可以通过修改 `baseUrl` 和 `model` 接入。

如果启用本地 routing，standalone runtime 会使用后端无关的 `routing.targets.pro`
/ `routing.targets.flash` 作为复杂请求和简单请求的主对话模型；未配置时两个分支都会退回
`llmBackend.openai.model`。旧 `routing.proModel` / `routing.flashModel` 只作为 Gemini
compatibility path 的兼容别名，避免 OpenAI-compatible 后端收到 Gemini 模型名。

当前主对话正式支持：

| Provider                | Main Chat       | Streaming         | Native Tools            | Runtime Mode                 |
| ----------------------- | --------------- | ----------------- | ----------------------- | ---------------------------- |
| Gemini CLI              | Yes             | Yes               | Yes                     | Compatibility                |
| OpenAI-compatible       | Yes             | Yes               | Yes                     | Standalone                   |
| Anthropic native        | No              | -                 | -                       | Future adapter               |
| Ollama native main chat | No              | -                 | -                       | Not planned in current phase |
| vLLM OpenAI API         | Compatible path | Depends on server | Depends on model/server | Standalone                   |

## 6. Dependency Boundary

根 workspace 不再包含 Gemini CLI packages。Gemini compatibility packages 通过根
`optionalDependencies` 引用：

```json
{
  "optionalDependencies": {
    "@google/gemini-cli": "file:gemini-cli/packages/cli",
    "@google/gemini-cli-core": "file:gemini-cli/packages/core"
  }
}
```

这意味着：

- standalone runtime 不需要把 Gemini CLI 作为 workspace 构建；
- compatibility mode 仍可通过根目录 `npm install` 安装所需依赖；
- 缺少 Gemini compatibility dependencies 时，启动错误会明确提示安装依赖或切换
  `llmBackend.provider=openai`。

`runtime:check-boundaries` 会阻止非 `gemini*` Jarvis core 文件静态 import Gemini CLI
或 `@google/genai`。

## 7. Quality Gates

Backend eval 已拆分为：

```bash
npm run llm:backend:eval
npm run llm:backend:eval:standalone
npm run llm:backend:eval:compatibility
```

Standalone 标准门禁：

```bash
npm run runtime:quality:standalone
```

完整 runtime 门禁：

```bash
npm run runtime:quality
```

当前离线覆盖包括：

- Gemini-compatible prompt compiler 和 tool loop；
- OpenAI-compatible streaming tool call；
- runtime tool result round-trip；
- deterministic required-tool enforcement；
- retry exhaustion；
- memory boundary；
- intent matrix；
- runtime package build；
- static dependency boundary。

Standalone suite 不加载 Gemini backend adapter，防止测试通过但进程仍隐式依赖
Gemini compatibility code。

## 8. Current Limitations

当前架构闭环不等于所有 provider 都已完成生产验证。

主要限制：

- OpenAI standalone path 需要真实凭据和真实服务的环境级 E2E；
- Anthropic 尚无 native adapter；
- vLLM 的 tool calling 能力取决于服务端和所选模型；
- 外部 subagent 可能仍自行使用 Gemini API，需要逐个迁移为 configurable provider；
- multimodal 输入在不同 backend 上尚未形成统一生产验收矩阵；
- backend latency、cost、retry、tool success 和 memory boundary 尚缺真实环境长期统计；
- `runtimeLogger` 仍以兼容日志输出为主，尚未形成统一结构化 trace sink。

## 9. Next Work

下一阶段不再继续重构主 runtime，而是验证其生产独立性。

### P0. Standalone Clean-Install CI

- 不初始化 Gemini CLI submodule；
- 使用 `npm install --omit=optional` 或等价隔离环境；
- 构建三个 runtime packages；
- 运行 `runtime:quality:standalone`；
- 验证 standalone 入口不会加载 Gemini modules。

### P0. Standalone End-To-End

覆盖：

- server startup；
- normal and streaming response；
- native tool calling；
- task、push、memory recall；
- session write、resume、time-scoped recall；
- background tasks；
- external personal-memory boundary；
- failed tool result prevents success claim。

### P1. Real Backend Matrix

至少验证：

- OpenAI；
- 一个 OpenAI-compatible gateway 或 vLLM deployment。

统计：

- latency；
- retry rate；
- tool-call success rate；
- tool-result completion correctness；
- memory boundary pass rate；
- token/cost；
- failure feedback promotion。

### P1. External Agent Provider Adapters

- 盘点直接调用 Gemini API/OAuth 的 external agents；
- 定义 external agent model provider contract；
- 优先迁移 investment-analysis；
- 保持 subagent `RuntimeContext` 和 `MemoryContract` 不变。

### P2. Structured Runtime Tracing

- 为 intent、memory、backend、tool、execution 建立统一 trace id；
- 增加 JSON sink；
- runtime quality dashboard 消费真实运行数据；
- 对 retry、repair、tool failure 和 policy denial 建立稳定 reason codes。

## 10. Definition Of Done

Backend adapter 层当前的工程闭环标准已经满足：

- 主 runtime 使用 backend-neutral protocol；
- Gemini CLI 是 compatibility adapter；
- OpenAI-compatible backend 可作为 standalone 主响应 backend；
- tool schema、tool request、tool result 和 loop sequencing 归 Jarvis runtime 所有；
- standalone quality gate 不加载 Gemini adapter；
- Gemini compatibility path 保留并可单独验证。

下一阶段的完成标准是生产验证：

- 无 Gemini clean install 环境可启动和运行 Jarvis；
- standalone E2E 覆盖主响应、工具、memory、session 和 background task；
- 至少一个真实非 Gemini backend 通过完整质量矩阵；
- 真实运行指标和失败样本进入 dashboard / feedback loop。
