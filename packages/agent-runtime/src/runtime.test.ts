import { describe, expect, it, vi } from "vitest";
import {
  AgentRuntime,
  DefaultResponseComposer,
  type RuntimeSkill,
} from "./index.js";
import {
  DefaultIntentRuntime,
  IntentExecutor,
  StaticIntentResolverAdapter,
  type RuntimeToolRequest,
  type RuntimeToolResult,
  type ToolExecutorAdapter,
} from "../../intent-runtime/src/index.js";
import {
  DefaultMemoryRuntime,
  type ConversationTurn,
  type IntentFrame,
  type IntentStep,
  type MemoryContract,
  type MemoryInjectionResult,
  type MemoryRetrievalResult,
} from "../../memory-runtime/src/index.js";

function step(overrides: Partial<IntentStep> = {}): IntentStep {
  return {
    id: "step-1",
    type: "schedule",
    action: "明天早上9点提醒我复盘",
    target: "明天早上9点提醒我复盘",
    operation: {
      domain: "task_management",
      action: "create",
      targetType: "task",
      target: "明天早上9点提醒我复盘",
      selector: "明天早上9点提醒我复盘",
      scope: "scheduled_tasks",
      riskLevel: "medium",
    },
    dependsOn: [],
    requiresConfirmation: false,
    riskLevel: "medium",
    ...overrides,
  };
}

function intent(overrides: Partial<IntentFrame> = {}): IntentFrame {
  const intentSteps = overrides.intentSteps ?? [step()];
  return {
    subject: "personal",
    taskType: "schedule",
    needsMemory: true,
    needsExternalKnowledge: false,
    needsTool: true,
    needsScheduling: true,
    candidateAgents: [],
    timeWindowDays: null,
    dateFrom: null,
    dateTo: null,
    resolvedDateRange: null,
    topicShifted: false,
    referencesRecentHistory: false,
    complexityScore: 40,
    knowledgeScore: 10,
    operationScore: 80,
    reason: "schedule reminder",
    confidence: 0.95,
    confidenceByDimension: {
      subject: 0.95,
      taskType: 0.95,
      memoryTarget: 0.95,
      action: 0.95,
      entityHints: 0.95,
      topicShift: 0.95,
      richIntent: 0.95,
    },
    evidence: ["明天早上9点提醒我复盘"],
    semanticEvidence: {
      personalContext: { present: true, reason: "personal", span: "我" },
      memoryRecall: { present: false, target: "none", reason: "", span: "" },
      actionRequest: {
        present: true,
        action: "schedule",
        object: "明天早上9点提醒我复盘",
      },
      entityHints: { tickers: [], technicalTerms: [], peopleOrCompanies: [] },
    },
    richIntent: {
      userGoal: "明天早上9点提醒我复盘",
      domain: "task_management",
      action: "create",
      primaryAction: "schedule",
      targets: [{ type: "task", value: "复盘" }],
      contextDependency: {
        recentConversation: false,
        longTermMemory: false,
        externalWorld: false,
        localWorkspace: false,
      },
      ambiguity: [],
      riskLevel: "medium",
    },
    intentSteps,
    topicAnalysis: {
      relation: "unknown",
      history: { label: "", evidence: [], sourceTurns: [], confidence: 0 },
      current: {
        label: "schedule request",
        evidence: ["明天早上9点提醒我复盘"],
        sourceTurns: [0],
        confidence: 0.95,
      },
      relationReason: "standalone",
      confidence: 0.95,
      lowGrounding: false,
    },
    policyTrace: [],
    source: "test",
    ...overrides,
  };
}

function memoryContract(
  overrides: Partial<MemoryContract> = {},
): MemoryContract {
  return {
    needMemory: true,
    subjectBoundary: "personal",
    targetScopes: ["fact", "entry"],
    memoryTarget: "user_memory",
    query: { raw: "复盘", entities: ["复盘"] },
    confidence: { subject: 0.95, target: 0.9, query: 0.9 },
    constraints: {
      allowPersonalFacts: true,
      allowSessionHistory: false,
      allowEntries: true,
      maxChars: 1200,
    },
    reasons: ["test"],
    policyTrace: [],
    ...overrides,
  };
}

function memoryRuntime(contract = memoryContract()) {
  const retrieval: MemoryRetrievalResult = {
    contract,
    session: [],
    facts: [],
    entries: [],
  };
  const injection: MemoryInjectionResult = {
    text: "<memory>user likes concise reminders</memory>",
    usedChars: 43,
    injected: { session: 0, facts: 0, entries: 1 },
    rejected: [],
    trace: [],
  };
  return {
    runtime: new DefaultMemoryRuntime<IntentFrame>({
      understand: async () => intent(),
      planMemory: vi.fn(async () => contract),
      retrieve: vi.fn(async () => retrieval),
      inject: vi.fn(async () => injection),
    }),
    retrieval,
    injection,
  };
}

function toolExecutor(
  fn: (request: RuntimeToolRequest) => RuntimeToolResult,
): ToolExecutorAdapter {
  return {
    executeTools: vi.fn(async (requests: RuntimeToolRequest[]) =>
      requests.map(fn),
    ),
  };
}

describe("AgentRuntime", () => {
  it("runs the full intent-memory-skill-execution-response lifecycle", async () => {
    const frame = intent();
    const events: string[] = [];
    const intentRuntime = new DefaultIntentRuntime(
      new StaticIntentResolverAdapter(async () => frame),
    );
    const memory = memoryRuntime();
    const toolAdapter = toolExecutor((request) => ({
      name: request.name,
      callId: request.callId,
      status: "success",
      output: "✅ Jarvis internal task added",
    }));
    const executor = new IntentExecutor(toolAdapter);
    const skills: RuntimeSkill[] = [
      { name: "scheduler", description: "Create Jarvis scheduled tasks" },
    ];
    const runtime = new AgentRuntime(intentRuntime, memory.runtime, executor, {
      skillRuntime: { retrieve: vi.fn(async () => skills) },
      observer: (event) => events.push(event.type),
    });

    const result = await runtime.handleTurn({
      sessionId: "s1",
      userPrompt: "明天早上9点提醒我复盘",
      history: [],
    });

    expect(result.context.intent).toBe(frame);
    expect(result.context.memoryContract?.memoryTarget).toBe("user_memory");
    expect(result.context.stepMemoryDecisions).toHaveLength(1);
    expect(result.context.skills.map((skill) => skill.name)).toEqual([
      "scheduler",
    ]);
    expect(result.context.execution?.status).toBe("succeeded");
    expect(result.response.canClaimSuccess).toBe(true);
    expect(result.response.systemContext).toContain("<memory_decision>");
    expect(result.response.systemContext).toContain("<runtime_skills>");
    expect(toolAdapter.executeTools).toHaveBeenCalledOnce();
    expect(events).toEqual([
      "turn_started",
      "intent_completed",
      "memory_completed",
      "skills_completed",
      "execution_completed",
      "response_composed",
      "turn_completed",
    ]);
  });

  it("shares external memory boundaries with response composition and step decisions", async () => {
    const frame = intent({ subject: "external", needsMemory: false });
    const contract = memoryContract({
      needMemory: false,
      subjectBoundary: "external",
      targetScopes: [],
      memoryTarget: "none",
      constraints: {
        allowPersonalFacts: false,
        allowSessionHistory: false,
        allowEntries: false,
        maxChars: 0,
      },
      reasons: ["external_subject"],
    });
    const intentRuntime = new DefaultIntentRuntime(
      new StaticIntentResolverAdapter(async () => frame),
    );
    const memory = memoryRuntime(contract);
    const runtime = new AgentRuntime(intentRuntime, memory.runtime, undefined, {
      executionMode: "skip",
      responseComposer: new DefaultResponseComposer(),
    });

    const result = await runtime.handleTurn({
      sessionId: "s1",
      userPrompt: "Gemini Spark 发布了吗？",
    });

    expect(result.context.memoryRetrieval?.entries).toEqual([]);
    expect(result.context.stepMemoryDecisions[0].constraints).toMatchObject({
      allowPersonalFacts: false,
      allowSessionHistory: false,
      allowEntries: false,
    });
    expect(result.response.instructions.join("\n")).toContain(
      "external request",
    );
    expect(result.response.systemContext).toContain(
      "allow_personal_facts: false",
    );
  });

  it("blocks success claims in composed response when execution is incomplete", async () => {
    const frame = intent();
    const intentRuntime = new DefaultIntentRuntime(
      new StaticIntentResolverAdapter(async () => frame),
    );
    const memory = memoryRuntime();
    const executor = new IntentExecutor(
      toolExecutor((request) => ({
        name: request.name,
        callId: request.callId,
        status: "failed",
        output: "❌ scheduler unavailable",
      })),
      undefined,
      { maxAttemptsPerStep: 1 },
    );
    const runtime = new AgentRuntime(intentRuntime, memory.runtime, executor);

    const result = await runtime.handleTurn({
      sessionId: "s1",
      userPrompt: "明天早上9点提醒我复盘",
    });

    expect(result.context.execution?.status).toBe("blocked");
    expect(result.response.canClaimSuccess).toBe(false);
    expect(result.response.systemContext).toContain("Do not claim completion");
  });
});
