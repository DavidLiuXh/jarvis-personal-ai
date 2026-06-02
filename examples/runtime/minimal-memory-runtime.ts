import {
  DefaultMemoryRuntime,
  type IntentFrame,
  type MemoryContract,
  type MemoryInjectionResult,
  type MemoryRetrievalResult,
} from "@jarvis/memory-runtime";
import { createSampleIntent } from "./sampleIntent.js";

const memoryContract: MemoryContract = {
  needMemory: true,
  subjectBoundary: "personal",
  targetScopes: ["fact"],
  memoryTarget: "user_profile",
  query: { raw: "What does the user prefer?", entities: ["user"] },
  confidence: { subject: 1, target: 1, query: 0.9 },
  constraints: {
    allowPersonalFacts: true,
    allowSessionHistory: false,
    allowEntries: false,
    maxChars: 800,
  },
  reasons: ["example_profile_lookup"],
  policyTrace: [],
};

const runtime = new DefaultMemoryRuntime<IntentFrame>({
  async understand(input) {
    return createSampleIntent({
      subject: "personal",
      taskType: "recall",
      needsMemory: true,
      source: "example",
      evidence: [input.prompt],
    });
  },
  async planMemory() {
    return memoryContract;
  },
  async retrieve(contract): Promise<MemoryRetrievalResult> {
    return {
      contract,
      session: [],
      facts: [
        {
          item: {
            id: "fact-1",
            scope: "fact",
            subject: "preference",
            content: "The user prefers concise Chinese responses.",
            confidence: 0.95,
            sourceRefs: ["profile"],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          score: 0.92,
        },
      ],
      entries: [],
    };
  },
  async inject({ retrieval }): Promise<MemoryInjectionResult> {
    const facts = retrieval.facts.map((fact) => fact.item.content);
    return {
      text: facts.join("\n"),
      usedChars: facts.join("\n").length,
      injected: { session: 0, facts: facts.length, entries: 0 },
      rejected: [],
      trace: [],
    };
  },
});

const intent = await runtime.understand({
  sessionId: "demo",
  prompt: "Remember my preferences?",
  history: [],
});
const contract = await runtime.planMemory({
  prompt: "Remember my preferences?",
  history: [],
  intent,
});
const retrieval = await runtime.retrieve(contract);
const injection = await runtime.inject({
  prompt: "Remember my preferences?",
  intent,
  contract,
  retrieval,
  budget: { maxChars: 800 },
});

console.log(injection.text);
