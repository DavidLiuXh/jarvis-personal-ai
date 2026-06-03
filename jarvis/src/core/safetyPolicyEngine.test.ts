import { describe, expect, it } from "vitest";
import { JarvisSafetyPolicyEngine } from "./safetyPolicyEngine.js";

describe("JarvisSafetyPolicyEngine", () => {
  it("denies personal recall when MemoryContract is external", async () => {
    const decision = await new JarvisSafetyPolicyEngine().checkToolCall(
      { name: "recall_memory", callId: "c1", args: { query: "history" } },
      {
        memoryContract: {
          needMemory: false,
          subjectBoundary: "external",
          targetScopes: [],
          memoryTarget: "none",
          query: { raw: "external", entities: [] },
          confidence: { subject: 1, target: 1, query: 1 },
          constraints: {
            allowPersonalFacts: false,
            allowSessionHistory: false,
            allowEntries: false,
            maxChars: 1800,
          },
          reasons: ["external_subject"],
          policyTrace: [],
        },
      },
    );

    expect(decision).toMatchObject({
      allowed: false,
      reasonCode: "MEMORY_CONTRACT_DENIES_RECALL",
    });
  });
});
