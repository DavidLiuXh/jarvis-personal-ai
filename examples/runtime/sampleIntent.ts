import type {
  IntentFrame,
  IntentTaskType,
  QuerySubject,
  RichIntentAction,
  RichIntentPrimaryAction,
} from "@jarvis/memory-runtime";

export function createSampleIntent(
  overrides: Partial<IntentFrame> = {},
): IntentFrame {
  const subject: QuerySubject = overrides.subject ?? "external";
  const taskType: IntentTaskType = overrides.taskType ?? "analyze";
  const action: RichIntentAction =
    overrides.richIntent?.action ??
    (taskType === "schedule" ? "schedule" : "analyze");
  const primaryAction: RichIntentPrimaryAction =
    overrides.richIntent?.primaryAction ??
    (taskType === "schedule" ? "schedule" : "analyze");

  return {
    subject,
    taskType,
    needsMemory: subject !== "external",
    needsExternalKnowledge: subject !== "personal",
    needsTool: taskType === "schedule" || taskType === "execute",
    needsScheduling: taskType === "schedule",
    candidateAgents: [],
    timeWindowDays: null,
    dateFrom: null,
    dateTo: null,
    resolvedDateRange: null,
    topicShifted: false,
    referencesRecentHistory: false,
    complexityScore: 40,
    knowledgeScore: 40,
    operationScore: taskType === "schedule" ? 80 : 20,
    reason: "sample intent",
    confidence: 0.9,
    confidenceByDimension: {
      subject: 0.9,
      taskType: 0.9,
      memoryTarget: 0.8,
      action: 0.8,
      entityHints: 0.8,
      topicShift: 0.8,
      richIntent: 0.8,
    },
    evidence: ["sample"],
    semanticEvidence: {
      personalContext: {
        present: subject !== "external",
        reason: "sample",
      },
      memoryRecall: { present: false, target: "none", reason: "sample" },
      actionRequest: {
        present: taskType === "schedule" || taskType === "execute",
        action: taskType === "schedule" ? "schedule" : "none",
      },
      entityHints: {
        tickers: [],
        technicalTerms: [],
        peopleOrCompanies: [],
      },
    },
    richIntent: {
      userGoal: "sample request",
      domain: taskType === "schedule" ? "task_management" : "general_chat",
      action,
      primaryAction,
      targets: [],
      contextDependency: {
        recentConversation: false,
        longTermMemory: subject !== "external",
        localWorkspace: false,
        externalWorld: subject !== "personal",
      },
      ambiguity: [],
      riskLevel: taskType === "schedule" ? "medium" : "low",
    },
    intentSteps: [],
    topicAnalysis: {
      history: { label: "none", evidence: [], sourceTurns: [], confidence: 1 },
      current: {
        label: "sample",
        evidence: ["sample"],
        sourceTurns: [],
        confidence: 1,
      },
      relation: "new_topic",
      relationReason: "sample",
      confidence: 1,
      lowGrounding: false,
    },
    policyTrace: [],
    source: "example",
    ...overrides,
  };
}
