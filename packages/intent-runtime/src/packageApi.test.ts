import { describe, expect, it } from "vitest";
import {
  DefaultIntentRuntime,
  AutonomousTaskRuntime,
  IntentConfidenceGateError,
  IntentResolver,
  IntentStepRuntime,
  InMemoryTaskGraphExecutionStore,
  OpenAICompatibleIntentModelClient,
  StaticIntentResolverAdapter,
  TaskGraphExecutor,
  buildIntentExecutionPlan,
  buildTaskGraph,
  buildTaskGraphGoldenTrace,
  decideTaskGraphRecovery,
  evaluateIntentConfidence,
  validateTaskGraphGoldenTrace,
} from "./index.js";
import type { IntentModelClient } from "./index.js";
import type { IntentFrame } from "../../memory-runtime/src/index.js";

describe("@jarvis/intent-runtime package API", () => {
  function scheduleIntent(): IntentFrame {
    return {
      subject: "personal",
      taskType: "schedule",
      needsMemory: false,
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
      reason: "schedule request",
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
        personalContext: {
          present: true,
          reason: "personal reminder",
          span: "我",
        },
        memoryRecall: {
          present: false,
          target: "none",
          reason: "",
          span: "",
        },
        actionRequest: {
          present: true,
          action: "schedule",
          object: "明天早上9点提醒我复盘",
        },
        entityHints: {
          tickers: [],
          technicalTerms: [],
          peopleOrCompanies: [],
        },
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
      intentSteps: [
        {
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
          riskLevel: "low",
        },
      ],
      topicAnalysis: {
        relation: "unknown",
        history: {
          label: "",
          evidence: [],
          sourceTurns: [],
          confidence: 0,
        },
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
    };
  }

  it("exports execution plan and step runtime primitives", () => {
    const intent = scheduleIntent();
    expect(buildIntentExecutionPlan(intent)?.requiredTools).toContain(
      "task_add",
    );
    expect(
      new IntentStepRuntime(intent).buildDeterministicToolRequests(),
    ).toEqual([
      {
        name: "task_add",
        callId: "intent-step-1-task_add",
        args: {
          cron: "明天早上9点",
          prompt: "提醒我复盘",
        },
      },
    ]);
  });

  it("exports task graph planning and execution primitives", () => {
    const graph = buildTaskGraph(scheduleIntent());
    expect(graph.nodes.map((node) => node.kind)).toEqual(["schedule"]);
    expect(TaskGraphExecutor).toBeTypeOf("function");
    expect(AutonomousTaskRuntime).toBeTypeOf("function");
    expect(decideTaskGraphRecovery).toBeTypeOf("function");
    expect(buildTaskGraphGoldenTrace).toBeTypeOf("function");
    expect(validateTaskGraphGoldenTrace).toBeTypeOf("function");
    expect(new InMemoryTaskGraphExecutionStore()).toBeTruthy();
  });

  it("exports a full intent runtime lifecycle", async () => {
    const intent = {
      ...scheduleIntent(),
      semanticEvidence: {
        ...scheduleIntent().semanticEvidence,
        actionRequest: {
          present: true,
          action: "schedule",
          object: "提醒我复盘",
        },
      },
      evidence: ["提醒我复盘"],
      intentSteps: [
        {
          ...scheduleIntent().intentSteps[0],
          action: "create reminder",
          target: "复盘",
          operation: {
            ...scheduleIntent().intentSteps[0].operation,
            target: "复盘",
            selector: "复盘",
          },
        },
      ],
    } as IntentFrame;
    const events: string[] = [];
    const runtime = new DefaultIntentRuntime(
      new StaticIntentResolverAdapter(() => intent, "test-resolver"),
      {
        config: {
          observer: (event) => {
            events.push(event.type);
          },
        },
      },
    );

    const result = await runtime.understand({
      userPrompt: "提醒我复盘",
      history: [],
      now: new Date("2026-05-31T00:00:00.000Z"),
    });

    expect(result.source).toBe("test-resolver");
    expect(result.intent).toBe(intent);
    expect(result.clarification.blocking).toBe(true);
    expect(result.executionPlan?.mode).toBe("orchestrated");
    expect(events).toEqual([
      "intent_resolve_started",
      "intent_resolved",
      "policy_evaluated",
      "confidence_evaluated",
      "clarification_resolved",
      "execution_planned",
    ]);
  });

  it("exports confidence gate evaluation for runtime quality contracts", async () => {
    const intent = scheduleIntent();
    const evaluation = evaluateIntentConfidence(intent, [
      { dimension: "overall", min: 0.9, severity: "critical" },
      { dimension: "action", min: 0.9 },
    ]);

    expect(evaluation.passed).toBe(true);
    expect(evaluation.critical).toHaveLength(0);
    expect(evaluation.warnings).toHaveLength(0);

    const events: string[] = [];
    const runtime = new DefaultIntentRuntime(
      new StaticIntentResolverAdapter(() => ({
        ...intent,
        confidence: 0.42,
      })),
      {
        config: {
          confidenceGates: [
            {
              dimension: "overall",
              min: 0.9,
              severity: "critical",
              reasonCode: "low_overall_confidence",
            },
          ],
          failOnCriticalConfidenceGate: true,
          observer: (event) => {
            events.push(event.type);
          },
        },
      },
    );

    await expect(
      runtime.understand({
        userPrompt: "明天早上9点提醒我复盘",
        history: [],
        now: new Date("2026-05-31T00:00:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(IntentConfidenceGateError);
    expect(events).toEqual([
      "intent_resolve_started",
      "intent_resolved",
      "policy_evaluated",
      "confidence_evaluated",
      "intent_runtime_failed",
    ]);
  });

  it("exports the model-backed IntentResolver without Jarvis core dependencies", async () => {
    const modelClient: IntentModelClient = {
      async generateJson() {
        return JSON.stringify({
          complexity_score: 35,
          knowledge_score: 70,
          operation_score: 10,
          complexity_reasoning: "simple external question",
          query_subject: "external",
          task_type: "analyze",
          needs_external_knowledge: true,
          needs_tool: false,
          needs_scheduling: false,
          candidate_agents: [],
          confidence: 0.9,
          confidence_by_dimension: {
            subject: 0.9,
            taskType: 0.9,
            memoryTarget: 0.9,
            action: 0.9,
            entityHints: 0.9,
            topicShift: 0.9,
            richIntent: 0.9,
          },
          evidence: ["weather"],
          semantic_evidence: {
            personalContext: { present: false, reason: "" },
            memoryRecall: { present: false, target: "none", reason: "" },
            actionRequest: { present: false, action: "none" },
            entityHints: {
              tickers: [],
              technicalTerms: [],
              peopleOrCompanies: [],
            },
          },
          topic_analysis: {
            history: {
              label: "",
              evidence: [],
              sourceTurns: [],
              confidence: 0,
            },
            current: {
              label: "weather",
              evidence: ["天气怎么样"],
              sourceTurns: [0],
              confidence: 0.9,
            },
            relation: "unknown",
            relationReason: "no history",
            confidence: 0.9,
            lowGrounding: false,
          },
        });
      },
    };
    const resolver = new IntentResolver({ modelClient });
    const intent = await resolver.resolve({
      userPrompt: "天气怎么样",
      history: [],
      now: new Date("2026-06-02T00:00:00.000Z"),
    });

    expect(intent.subject).toBe("external");
    expect(intent.taskType).toBe("analyze");
    expect(intent.source).toBe("model");
  });

  it("exports an OpenAI-compatible remote IntentModelClient", async () => {
    const client = new OpenAICompatibleIntentModelClient({
      apiKey: "test-key",
      model: "test-model",
      baseUrl: "https://example.test/v1",
      fetchFn: async (url, init) =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"ok":true}' } }],
            url,
            method: init?.method,
          }),
          { status: 200 },
        ),
    });

    await expect(
      client.generateJson({
        system: "Return JSON.",
        prompt: "Classify intent.",
        responseFormat: "json",
      }),
    ).resolves.toBe('{"ok":true}');
  });
});
