# @jarvis/memory-runtime

Reusable memory lifecycle primitives extracted from Jarvis.

## Boundary

This package owns:

- intent and memory schema types;
- memory contract planning helpers;
- memory retrieval and injection interfaces;
- clarification and memory policy helpers;
- the minimal `DefaultMemoryRuntime` lifecycle.

It must not import from `jarvis/src/core` or from `@jarvis/intent-runtime`.

## Minimal Usage

```ts
import {
  DefaultMemoryRuntime,
  MemoryInjectionPlanner,
  type MemoryContract,
} from "@jarvis/memory-runtime";

const runtime = new DefaultMemoryRuntime({
  async understand(turn) {
    return { query: turn.userPrompt, subject: "mixed" };
  },
  async planMemory(): Promise<MemoryContract> {
    return {
      needMemory: false,
      subjectBoundary: "mixed",
      memoryTarget: "none",
      targetScopes: [],
      dateRange: null,
      timeWindowDays: null,
      prewarmLimit: 0,
      maxDistance: 1,
    };
  },
  async retrieve() {
    return { session: [], facts: [], entries: [] };
  },
  async inject() {
    return {
      systemPromptSection: "",
      usedChars: 0,
      injected: [],
      rejected: [],
      trace: [],
    };
  },
});

const turn = {
  sessionId: "demo",
  prompt: "hello",
  history: [],
  timestamp: new Date().toISOString(),
};

const intent = await runtime.understand(turn);
const contract = await runtime.planMemory({
  prompt: turn.prompt,
  history: turn.history,
  intent,
});
const retrieval = await runtime.retrieve(contract);
const injected = await runtime.inject({
  prompt: turn.prompt,
  intent,
  contract,
  retrieval,
  budget: { maxChars: 4000 },
});
```

## Compatibility

Jarvis still exposes compatibility re-exports under `jarvis/src/memory-runtime/*`.
New runtime code should import from `packages/memory-runtime/src/*` or the package
entrypoint.
