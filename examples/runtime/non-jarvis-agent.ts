import {
  AgentRuntime,
  type RuntimeResponse,
  type SkillRuntime,
} from "@jarvis/agent-runtime";
import {
  DefaultIntentRuntime,
  IntentExecutor,
  StaticIntentResolverAdapter,
} from "@jarvis/intent-runtime";
import {
  DefaultMemoryRuntime,
  type IntentFrame,
  type MemoryContract,
} from "@jarvis/memory-runtime";
import { createSampleIntent } from "./sampleIntent.js";

const intent = createSampleIntent({
  subject: "external",
  taskType: "analyze",
  needsMemory: false,
  needsTool: false,
  needsScheduling: false,
  intentSteps: [],
  source: "non-jarvis-example",
});

const intentRuntime = new DefaultIntentRuntime(
  new StaticIntentResolverAdapter(async () => intent),
);

const noMemory: MemoryContract = {
  needMemory: false,
  subjectBoundary: "external",
  targetScopes: [],
  memoryTarget: "none",
  query: { raw: "", entities: [] },
  confidence: { subject: 1, target: 1, query: 1 },
  constraints: {
    allowPersonalFacts: false,
    allowSessionHistory: false,
    allowEntries: false,
    maxChars: 0,
  },
  reasons: ["external_request"],
  policyTrace: [],
};

const memoryRuntime = new DefaultMemoryRuntime<IntentFrame>({
  async understand() {
    return intent;
  },
  async planMemory() {
    return noMemory;
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

const skillRuntime: SkillRuntime = {
  async retrieve() {
    return [{ name: "market-analysis", description: "Analyze market context" }];
  },
};

const runtime = new AgentRuntime(
  intentRuntime,
  memoryRuntime,
  new IntentExecutor({
    async executeTools() {
      return [];
    },
  }),
  { skillRuntime },
);

const result = await runtime.handleTurn({
  sessionId: "external-agent",
  userPrompt: "Analyze the current AI search market",
});

const response: RuntimeResponse = result.response;
console.log(response.systemContext);
