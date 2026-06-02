# @jarvis/memory-runtime

Reusable memory lifecycle primitives extracted from Jarvis.

## Boundary

This package owns:

- intent and memory schema types;
- memory contract planning helpers;
- memory retrieval and injection interfaces;
- clarification and memory policy helpers;
- the `DefaultMemoryRuntime` read lifecycle;
- memory write governance and `DefaultMemoryWriterRuntime`;
- a dependency-free `DefaultMemoryStore` reference implementation.

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
      query: { raw: "hello", entities: [] },
      confidence: { subject: 1, target: 1, query: 1 },
      constraints: {
        allowPersonalFacts: false,
        allowSessionHistory: false,
        allowEntries: false,
        maxChars: 0,
      },
      reasons: ["example"],
      policyTrace: [],
    };
  },
  async retrieve(contract) {
    return { contract, session: [], facts: [], entries: [] };
  },
  async inject() {
    return {
      text: "",
      usedChars: 0,
      injected: { session: 0, facts: 0, entries: 0 },
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

## Write Runtime

Use `DefaultMemoryWriterRuntime` when the host wants memory writes to go through
deterministic governance instead of writing directly to storage.

```ts
import {
  DefaultMemoryStore,
  DefaultMemoryWriterRuntime,
} from "@jarvis/memory-runtime";

const store = new DefaultMemoryStore();
const writer = new DefaultMemoryWriterRuntime({ store });

await writer.write([
  {
    operation: "upsert",
    item: {
      id: "fact-1",
      scope: "fact",
      subject: "preference",
      content: "The user prefers concise Chinese replies.",
      confidence: 0.95,
      sourceRefs: ["profile"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  },
]);
```

The default governance policy handles:

- empty-content rejection;
- duplicate merge;
- lower-confidence conflict skipping;
- higher-confidence replacement;
- session upsert;
- explicit delete.

`DefaultMemoryStore` implements the read adapters (`FactMemoryStore`,
`EntryMemoryStore`, `SessionMemoryStore`) and write adapter (`MemoryWriteStore`).
It is dependency-free and suitable for tests, examples, small agents, and as a
reference implementation. Production hosts can replace it with SQLite, pgvector,
Qdrant, Milvus, Pinecone, or their own storage layer while keeping the same
runtime contracts.

## Compatibility

Jarvis still exposes compatibility re-exports under `jarvis/src/memory-runtime/*`.
New runtime code should import from `packages/memory-runtime/src/*` or the package
entrypoint.
