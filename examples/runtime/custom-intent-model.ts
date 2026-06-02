import {
  DefaultIntentRuntime,
  StaticIntentResolverAdapter,
  type IntentRuntimeResult,
} from "@jarvis/intent-runtime";
import type { IntentFrame } from "@jarvis/memory-runtime";
import { createSampleIntent } from "./sampleIntent.js";

function makeIntent(prompt: string): IntentFrame {
  return createSampleIntent({
    subject: prompt.includes("my") ? "personal" : "external",
    taskType: prompt.includes("schedule") ? "schedule" : "analyze",
    needsMemory: prompt.includes("my"),
    needsExternalKnowledge: !prompt.includes("my"),
    needsTool: prompt.includes("schedule"),
    needsScheduling: prompt.includes("schedule"),
    candidateAgents: [],
    timeWindowDays: null,
    dateFrom: null,
    dateTo: null,
    resolvedDateRange: null,
    topicShifted: false,
    referencesRecentHistory: false,
    complexityScore: 40,
    knowledgeScore: 40,
    operationScore: 20,
    reason: "example resolver",
    confidence: 0.9,
    evidence: [prompt],
    semanticEvidence: {
      personalContext: { present: prompt.includes("my"), reason: "example" },
      memoryRecall: { present: false, target: "none", reason: "example" },
      actionRequest: {
        present: prompt.includes("schedule"),
        action: prompt.includes("schedule") ? "schedule" : "none",
      },
      entityHints: {
        tickers: [],
        technicalTerms: [],
        peopleOrCompanies: [],
      },
    },
    richIntent: {
      userGoal: prompt,
      domain: "general_chat",
      action: prompt.includes("schedule") ? "schedule" : "analyze",
      primaryAction: prompt.includes("schedule") ? "schedule" : "analyze",
      targets: [],
      contextDependency: {
        recentConversation: false,
        longTermMemory: prompt.includes("my"),
        localWorkspace: false,
        externalWorld: !prompt.includes("my"),
      },
      ambiguity: [],
      riskLevel: "low",
    },
    topicAnalysis: createSampleIntent().topicAnalysis,
    source: "custom-example",
  });
}

const resolver = new StaticIntentResolverAdapter(async ({ userPrompt }) =>
  makeIntent(userPrompt),
);
const runtime = new DefaultIntentRuntime(resolver);

const result: IntentRuntimeResult = await runtime.understand({
  userPrompt: "Analyze AI search trends",
  history: [],
});

console.log(result.intent.subject, result.intent.taskType);
