import { describe, expect, it } from "vitest";
import {
  DefaultMemoryRuntime,
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
      dateRange: null,
      timeWindowDays: null,
      prewarmLimit: 0,
      maxDistance: 1,
    };
    const runtime = new DefaultMemoryRuntime({
      async understand(turn) {
        return { query: turn.userPrompt, subject: "mixed" };
      },
      async planMemory() {
        return contract;
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
});
