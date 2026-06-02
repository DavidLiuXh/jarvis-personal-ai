import { describe, expect, it } from "vitest";
import {
  DefaultMemoryRuntime,
  DefaultMemoryStore,
  DefaultMemoryWriterRuntime,
  MemoryInjectionPlanner,
  buildIntentAwareMemoryPolicy,
  type MemoryContract,
} from "./index.js";

describe("@jarvis/memory-runtime package API", () => {
  it("exports the minimal runtime lifecycle and policy helpers", async () => {
    const contract: MemoryContract = {
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
      reasons: ["test"],
      policyTrace: [],
    };
    const runtime = new DefaultMemoryRuntime({
      async understand(turn) {
        return { query: turn.prompt, subject: "mixed" };
      },
      async planMemory() {
        return contract;
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
      sessionId: "test",
      prompt: "hello",
      history: [],
      timestamp: "2026-05-31T00:00:00.000Z",
    };
    const intent = await runtime.understand(turn);
    const planned = await runtime.planMemory({
      prompt: turn.prompt,
      history: turn.history,
      intent,
    });
    const retrieval = await runtime.retrieve(planned);
    const result = await runtime.inject({
      prompt: turn.prompt,
      intent,
      contract: planned,
      retrieval,
      budget: { maxChars: 100 },
    });

    expect(result.usedChars).toBe(0);
    expect(
      new MemoryInjectionPlanner().buildPlan({
        querySubject: "personal",
        factCandidates: [
          {
            category: "interaction_style",
            content: "user likes concise replies",
          },
        ],
        summaryCandidates: [],
        prewarmCandidates: [],
      }).facts,
    ).toHaveLength(1);
    expect(
      buildIntentAwareMemoryPolicy({
        userPrompt: "hello",
        querySubject: "external",
        intent: null,
        config: {},
      }).allowFacts,
    ).toBe(false);
  });

  it("exports writer, governance, and default store APIs", async () => {
    const store = new DefaultMemoryStore();
    const writer = new DefaultMemoryWriterRuntime({ store });
    const [result] = await writer.write([
      {
        operation: "upsert",
        item: {
          id: "fact-1",
          scope: "fact",
          subject: "preference",
          content: "The user prefers concise Chinese replies.",
          confidence: 0.95,
          sourceRefs: ["test"],
          createdAt: "2026-06-02T00:00:00.000Z",
          updatedAt: "2026-06-02T00:00:00.000Z",
        },
      },
    ]);

    expect(result.decision.action).toBe("insert");
    expect(await store.listFacts()).toHaveLength(1);
  });
});
