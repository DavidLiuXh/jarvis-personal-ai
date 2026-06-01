# LLM Backend Adapter Strategy

This document records the current feasibility assessment and migration strategy
for supporting LLM backends other than Gemini CLI in Jarvis.

## Current Assessment

Jarvis can support additional LLM backends, but today this is not a
configuration-only switch for the main chat path.

Recent intent-driven runtime work has already moved important Jarvis semantics
out of Gemini-specific code:

- `packages/intent-runtime` owns intent lifecycle primitives, execution plans,
  confidence gates, and the new runtime executor.
- `ToolExecutorAdapter` and `IntentExecutor` provide backend-neutral execution
  contracts for tool-backed work.
- `JarvisIntentResolverAdapter` isolates Jarvis core `IntentResolver` behind a
  runtime adapter.
- Intent matrix evaluation can run through `DefaultIntentRuntime`, rather than
  constructing Jarvis resolver internals directly.

The remaining hard coupling is the main conversation loop. It still follows the
Gemini CLI protocol:

```text
agent.ts
  -> Gemini client sendMessageStream()
  -> GeminiEventType.Content / ToolCallRequest / Error
  -> Gemini Part[] / functionResponse tool result format
  -> ToolRouter.route()
  -> send tool response parts back into Gemini stream loop
```

This means Jarvis can already swap some backend-like components, but the primary
chat backend still depends on Gemini CLI event and tool-result shapes.

## Feasibility By Component

### Intent Resolver

Feasibility: high.

`IntentResolver` already accepts a `modelClient`, and P4 introduced
`JarvisIntentResolverAdapter`. This makes it realistic to use local Ollama,
OpenAI, Anthropic, or another JSON-producing model for intent understanding.

Remaining work:

- Provide model-specific `IntentModelJsonClient` implementations.
- Reuse or specialize `IntentJsonRepairAdapter`.
- Add backend-specific eval runs to compare classification and policy behavior.

### Session Summarizer / Reflection / Distillation

Feasibility: high.

These flows are mostly single prompt -> text or JSON output, with no tool-calling
loop. They are good early candidates for non-Gemini backends.

Remaining work:

- Normalize timeout, retry, and JSON repair behavior across providers.
- Track quality and latency separately by backend.
- Keep output schemas backend-independent.

### Main Chat Backend

Feasibility: medium-high, but requires an adapter layer.

The core problem is not text generation. The hard part is the conversation loop:
streaming, tool calls, tool results, retries, and final response validation are
currently expressed in Gemini CLI terms.

To support other backends, Jarvis needs a backend-neutral `LlmBackend` interface
and a message/tool event protocol owned by Jarvis.

### Backends Without Native Tool Calling

Feasibility: possible, but should be treated as a different execution mode.

Local models or simple chat-completion backends may not reliably emit native
tool calls. For these, Jarvis should not depend on model-driven tool invocation.
Instead, the runtime should use intent understanding plus `IntentExecutor` to
execute deterministic steps.

Recommended modes:

- `native_tool_calling`: backend emits structured tool calls.
- `text_action_calling`: backend emits JSON actions that Jarvis parses and
  repairs.
- `planner_only`: backend produces reasoning/content, while `IntentExecutor`
  performs deterministic tool-backed obligations.

## Required Abstractions

### LLM Backend

Jarvis should own the canonical backend interface:

```ts
export type LlmBackend = {
  sendTurn(input: LlmTurnInput, signal: AbortSignal): AsyncIterable<LlmEvent>;
  getModel(): string;
  getCapabilities(): LlmBackendCapabilities;
};

export type LlmEvent =
  | { type: "content"; text: string }
  | { type: "tool_call"; request: RuntimeToolRequest }
  | { type: "error"; error: unknown }
  | { type: "metadata"; value: Record<string, unknown> };
```

Gemini CLI should become `GeminiCliBackendAdapter`, not the protocol used by the
Jarvis runtime itself.

### Backend Capabilities

Each backend should declare capabilities so the runtime can choose the right
strategy:

```ts
export type LlmBackendCapabilities = {
  streaming: boolean;
  nativeToolCalling: boolean;
  jsonMode: boolean;
  multimodalInput: boolean;
  maxContextTokens: number | null;
};
```

This lets Jarvis choose between native tool calls, JSON action parsing, or
deterministic runtime execution.

### Prompt / Message Compiler

System prompt construction, memory injection, tool results, and retry prompts
should be compiled into backend-specific messages at the boundary:

```ts
export type PromptCompiler = {
  compileInitialTurn(input: RuntimeTurnContext): BackendMessage[];
  compileToolResults(results: RuntimeToolResult[]): BackendMessage[];
  compileRetryPrompt(input: RuntimeRetryContext): BackendMessage[];
};
```

The runtime should not know whether the provider expects Gemini `Part[]`, OpenAI
messages, Anthropic content blocks, or plain text.

### Tool Calling Bridge

Runtime tools should use `RuntimeToolRequest` / `RuntimeToolResult`, not
provider-specific shapes.

Provider adapters are responsible for translating:

- Gemini function call parts <-> `RuntimeToolRequest`
- OpenAI tool calls <-> `RuntimeToolRequest`
- Anthropic tool_use/tool_result blocks <-> `RuntimeToolRequest`
- JSON action text <-> `RuntimeToolRequest`

P5 already added the central `ToolExecutorAdapter` shape. The next step is to
make the main `agent.ts` loop consume it through a backend-neutral
`AgentRuntime`.

## Recommended Migration Order

1. Define `LlmBackend`, `LlmEvent`, `LlmBackendCapabilities`, and
   `PromptCompiler` in a runtime package.
2. Implement `GeminiCliBackendAdapter` that preserves current behavior exactly.
3. Move the current `agent.ts` stream/tool loop into runtime-owned loop
   orchestration.
4. Connect `AgentRuntime` to `IntentRuntime`, memory runtime, skill retrieval,
   and `IntentExecutor`.
5. Add a non-Gemini backend for a low-risk path first, such as summarizer or
   intent resolver.
6. Add a main-chat backend with native tool calling, such as OpenAI or Anthropic.
7. Add a local-model backend in `planner_only` or `text_action_calling` mode.
8. Run intent matrix and execution-contract evals per backend.

## Current Implementation Status

Implemented in the P6 completion pass:

- `packages/agent-runtime/src/llmBackend.ts` defines the backend-neutral main
  chat protocol:
  - `LlmBackend`
  - `LlmEvent`
  - `LlmBackendCapabilities`
  - `LlmMessage`
  - `PromptCompiler`
  - `ToolLoopRuntime`
  - `ToolLoopPlanner`
- `ToolLoopRuntime` now owns the main response loop semantics that were
  previously hard-coded in `agent.ts`:
  - content streaming and buffering before required tool execution;
  - backend-native tool call collection;
  - tool execution through `ToolExecutorAdapter`;
  - duplicate tool-call suppression through a planner hook;
  - deterministic multi-intent tool enforcement;
  - missing-step enforcement prompts;
  - post-content tool completion, such as channel push auto-completion;
  - max tool iteration guard;
  - consecutive tool failure guard;
  - retry and retry-exhaustion cleanup hooks.
- `jarvis/src/core/geminiBackendAdapter.ts` implements the Gemini CLI
  compatibility boundary:
  - Gemini `sendMessageStream()` -> `LlmEvent`;
  - Gemini `ToolCallRequest` -> `RuntimeToolRequest`;
  - runtime tool results -> Gemini `functionResponse` blocks;
  - Gemini `Part[]` -> runtime `LlmMessage[]`.
- `agent.ts` no longer directly runs the Gemini stream/tool loop. It now acts
  as an application adapter that wires:
  - `GeminiCliBackendAdapter`;
  - `GeminiPromptCompiler`;
  - `ToolRouter` as a `ToolExecutorAdapter`;
  - Jarvis-specific `IntentStepRuntime` behavior through `ToolLoopPlanner`.

The key design decision is that provider-specific protocol translation belongs
at the backend adapter boundary, while loop safety, tool execution sequencing,
and final completion obligations belong to runtime. This prevents a future
OpenAI, Anthropic, Ollama, or local backend from inheriting Gemini `Part[]` and
Gemini event semantics as implicit Jarvis architecture.

Current test coverage:

- `packages/agent-runtime/src/llmBackend.test.ts`
  - streams content, executes tool calls, and resumes with tool results;
  - executes deterministic planner steps when the model omits required tools;
  - retries retryable backend errors and calls the exhaustion hook.
- `jarvis/src/core/geminiBackendAdapter.test.ts`
  - translates neutral messages into Gemini parts;
  - emits neutral content/tool events;
  - round-trips Gemini `functionResponse` through `RuntimeToolResult`;
  - verifies prompt compilation does not expose Gemini `Part[]` to runtime.

## Backend Candidates

### Gemini CLI Adapter

Purpose: compatibility backend.

This should remain the first adapter and preserve current behavior. It validates
that the abstraction did not regress the existing path.

### OpenAI / Anthropic Adapter

Purpose: production-grade alternate main chat backend.

These are good candidates because they support structured tool calling and
streaming. The primary work is message translation and tool-result formatting.

### Ollama / Local Model Adapter

Purpose: local and low-cost execution.

This is attractive for intent resolution, summarization, and reflection. For
main chat, local models should initially use `planner_only` or
`text_action_calling` because native tool calling may be less reliable.

## Risks

- Tool calling semantics differ across providers; blindly mapping one provider's
  protocol to another can create subtle action-completion bugs.
- Backends without strong structured output may increase JSON repair and fallback
  rates.
- Prompt token budgets and context-window behavior differ, so memory injection
  policy must be evaluated per backend.
- The main response must not claim success unless the runtime has observed
  successful tool results. This is especially important for channel push,
  task scheduling, file writes, shell commands, and subagent delegation.

## Near-Term Recommendation

Do not start by replacing Gemini CLI in the main chat path.

Instead:

1. Keep Gemini CLI as the compatibility backend.
2. Extract `AgentRuntime.handleTurn` and `LlmBackend` first.
3. Use non-Gemini models first for lower-risk single-call flows.
4. Only then add a second main-chat backend and verify it with the same runtime
   evals.

The strategic goal is to make Gemini CLI one backend adapter among several, not
the implicit protocol of the Jarvis runtime.
