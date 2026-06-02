# @jarvis/intent-runtime

Reusable intent understanding and execution-planning primitives extracted from
Jarvis.

## Boundary

This package owns:

- the `IntentRuntime` lifecycle: resolve intent, resolve clarification, plan
  execution;
- resolver adapter interfaces for host applications;
- the model-backed `IntentResolver` implementation;
- policy adapter interfaces for host-specific query-subject and policy-trace
  evaluation;
- model JSON client, JSON repair, deterministic fallback, and confidence-gate
  contracts for resolver implementations;
- execution orchestration through `IntentExecutor`, `ToolExecutorAdapter`,
  `AgentExecutorAdapter`, and registry-driven runtime capabilities;
- intent execution plan construction;
- step runtime state;
- required-tool enforcement helpers;
- duplicate/dependent tool-call suppression.

It may depend on `@jarvis/memory-runtime` schema and CRUD policy primitives. It
must not import from `jarvis/src/core`.

## Minimal Usage

```ts
import {
  DefaultIntentRuntime,
  IntentStepRuntime,
  StaticIntentResolverAdapter,
} from "@jarvis/intent-runtime";
import type { IntentFrame } from "@jarvis/memory-runtime";

const intentRuntime = new DefaultIntentRuntime(
  new StaticIntentResolverAdapter(async () => intentFrame as IntentFrame),
);

const result = await intentRuntime.understand({
  userPrompt: "明天早上9点提醒我复盘",
  history: [],
  now: new Date(),
});

console.log(result.intent.taskType);
console.log(result.clarification.state);
console.log(result.executionPlan?.requiredTools);

const runtime = new IntentStepRuntime(intentFrame as IntentFrame);
const missingPrompt = runtime.buildMissingStepPrompt();
const deterministicRequests = runtime.buildDeterministicToolRequests();
```

## Host Adapter

Applications can provide an `IntentResolverAdapter`, use the model-backed
`IntentResolver`, or provide a rule-based resolver without importing Jarvis core.
Jarvis keeps a compatibility shim in `jarvis/src/core/intentResolver.ts` so
existing imports keep working while the implementation lives in this package.

Resolver implementations can also compose the lower-level contracts exported by
this package:

- `IntentModelJsonClient` for model calls that return JSON-ish text and
  optional parsed output;
- `IntentJsonRepairAdapter` for deterministic or model-assisted JSON repair;
- `IntentFallbackAdapter` for deterministic fallback frames when model parsing
  fails or confidence is too low;
- `IntentPolicyAdapter` for host-specific policy evaluation before
  clarification;
- `IntentConfidenceGate` / `evaluateIntentConfidence()` for explicit runtime
  quality gates.

Model-backed resolver usage:

```ts
import {
  IntentResolver,
  OpenAICompatibleIntentModelClient,
} from "@jarvis/intent-runtime";

const resolver = new IntentResolver({
  modelClient: new OpenAICompatibleIntentModelClient({
    apiKey: process.env.OPENAI_API_KEY,
    model: "gpt-4.1-mini",
  }),
});

const intent = await resolver.resolve({
  userPrompt: "Compare React and Vue for my project",
  history: [],
});
```

Local Ollama usage can use `OllamaIntentModelClient` from the same entrypoint.
Internal gateways or local OpenAI-compatible servers can omit `apiKey`.

```ts
const guardedRuntime = new DefaultIntentRuntime(resolverAdapter, {
  config: {
    confidenceGates: [
      { dimension: "overall", min: 0.75, severity: "critical" },
      { dimension: "action", min: 0.7, severity: "warning" },
    ],
    failOnCriticalConfidenceGate: true,
  },
});
```

`DefaultIntentRuntime` emits `policy_evaluated` and `confidence_evaluated`, and
includes both evaluations in `result.diagnostics`.

## Execution Orchestration

`IntentExecutor` turns an `IntentExecutionPlan` into runtime-observed action. It
tracks step queue state, dependencies, retries, blocking, tool results, agent
results, and the final-response success contract.

```ts
const executor = new IntentExecutor(toolExecutorAdapter, agentExecutorAdapter);

const execution = await executor.execute({
  intent: result.intent,
  plan: result.executionPlan,
  context: {
    userPrompt,
    currentContent: markdownDraft,
  },
});

if (!execution.finalResponseContract.canClaimSuccess) {
  console.log(execution.finalResponseContract.instruction);
}
```

The default capability registry covers scheduled-task tools, `push_to_channel`,
`recall_memory`, workspace file tools, shell commands, and subagent delegation.
Hosts can replace the registry with their own `RuntimeCapabilityRegistry`.

## Compatibility

Jarvis still exposes compatibility re-exports under `jarvis/src/intent-runtime/*`.
New runtime code should import from `packages/intent-runtime/src/*` or the package
entrypoint.
