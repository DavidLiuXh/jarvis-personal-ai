# @jarvis/memory-runtime

Reusable memory lifecycle primitives extracted from Jarvis.

## Boundary

This package owns:

- intent and memory schema types;
- memory contract planning helpers;
- memory retrieval and injection interfaces;
- session transcript store contracts and dependency-free lexical search helpers;
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

For host projects that want one facade for all three layers, use
`DefaultLayeredMemoryRuntime`. It exposes save, search, delete, and recall for:

- `session`: transcript turns, summaries, and topic state;
- `fact`: durable profile, preference, project, and relationship facts;
- `entry`: episodic conversation, task, decision, event, and reflection records.

```ts
import {
  DefaultLayeredMemoryRuntime,
  DefaultMemoryStore,
} from "@jarvis/memory-runtime";

const store = new DefaultMemoryStore();
const memory = new DefaultLayeredMemoryRuntime({
  stores: { facts: store, entries: store, session: store },
  writeStore: store,
  sessionId: "demo",
});

await memory.saveEntry({
  id: "entry-1",
  scope: "entry",
  kind: "conversation",
  content: "Discussed a three-layer memory runtime.",
  entities: ["memory"],
  timestamp: new Date().toISOString(),
  sourceRefs: ["demo"],
});

const entries = await memory.searchEntries({ query: "three-layer memory" });
```

`DefaultMemoryStore` implements the read adapters (`FactMemoryStore`,
`EntryMemoryStore`, `SessionMemoryStore`) and write adapter (`MemoryWriteStore`).
It is dependency-free and suitable for tests, examples, small agents, and as a
reference implementation. Production hosts can replace it with SQLite, pgvector,
Qdrant, Milvus, Pinecone, or their own storage layer while keeping the same
runtime contracts.

## Session Transcript Store

Use `SessionStore` when the host needs to expose complete conversation
transcripts independently from any specific LLM backend.

```ts
import {
  JarvisJsonlSessionStore,
  type SessionStore,
} from "@jarvis/memory-runtime";

const writableStore = new JarvisJsonlSessionStore({
  dir: "/path/to/sessions",
});

await writableStore.appendTurn({
  sessionId: "demo",
  turn: {
    role: "user",
    content: "hello",
    metadata: { backend: "openai", model: "gpt-4.1" },
  },
});

const customStore: SessionStore = {
  capabilities: { read: true, write: false, search: true },
  async listSessions() {
    return [];
  },
  async readSession() {
    return null;
  },
  async searchTurns() {
    return [];
  },
};
```

`JarvisJsonlSessionStore` writes Jarvis Transcript JSONL v1:

Files are stored as
`YYYY-MM-DDTHH-MM-SS-sssZ_<sessionId>.jsonl`, using the first turn or session
creation timestamp. Legacy `<sessionId>.jsonl` files remain readable.

```jsonl
{"kind":"session","schemaVersion":1,"sessionId":"demo","source":"jarvis-jsonl-v1"}
{"kind":"turn","role":"user","content":"hello","timestamp":"2026-06-02T00:00:00.000Z","backend":"openai","model":"gpt-4.1"}
{"kind":"turn","role":"assistant","content":"hi","timestamp":"2026-06-02T00:00:01.000Z","backend":"openai","model":"gpt-4.1"}
```

`GeminiCliSessionStore` is also exported as a legacy read/search adapter for
existing Gemini CLI or Jarvis chat transcript files. It implements the same
`SessionStore` interface, so hosts can compose it behind `JarvisJsonlSessionStore`
with `CompositeSessionStore`. Other projects can also provide SQLite,
filesystem, Postgres, or backend-native session stores.

`conversationRecall` helpers are exported for recent in-memory conversation
recall. They extract specific recall terms and build short candidate windows
from the current turn history before falling back to persisted session search.

## Compatibility

Jarvis still exposes compatibility re-exports under `jarvis/src/memory-runtime/*`.
New runtime code should import from `packages/memory-runtime/src/*` or the package
entrypoint.
