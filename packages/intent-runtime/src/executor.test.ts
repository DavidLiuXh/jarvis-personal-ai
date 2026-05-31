import { describe, expect, it, vi } from "vitest";
import {
  IntentExecutor,
  buildIntentExecutionPlan,
  type RuntimeToolRequest,
  type RuntimeToolResult,
  type ToolExecutorAdapter,
} from "./index.js";
import type {
  IntentFrame,
  IntentStep,
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
    riskLevel: "low",
    ...overrides,
  };
}

function intent(overrides: Partial<IntentFrame> = {}): IntentFrame {
  const intentSteps = overrides.intentSteps ?? [step()];
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
    reason: "明天早上9点提醒我复盘",
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

function toolExecutor(
  fn: (request: RuntimeToolRequest) => RuntimeToolResult,
): ToolExecutorAdapter {
  return {
    executeTools: vi.fn(async (requests: RuntimeToolRequest[]) =>
      requests.map(fn),
    ),
  };
}

describe("IntentExecutor", () => {
  it("executes deterministic task tool steps and validates final success", async () => {
    const events: string[] = [];
    const adapter = toolExecutor((request) => ({
      name: request.name,
      callId: request.callId,
      status: "success",
      output: "✅ task created",
    }));
    const executor = new IntentExecutor(adapter, undefined, {
      observer: (event) => {
        events.push(event.type);
      },
    });

    const result = await executor.execute({
      intent: intent(),
      context: { userPrompt: "明天早上9点提醒我复盘" },
    });

    expect(result.status).toBe("succeeded");
    expect(result.completedTools).toEqual(["task_add"]);
    expect(result.finalResponseContract.canClaimSuccess).toBe(true);
    expect(adapter.executeTools).toHaveBeenCalledOnce();
    expect((adapter.executeTools as any).mock.calls[0][0][0].name).toBe(
      "task_add",
    );
    expect(events).toContain("execution_started");
    expect(events).toContain("tool_requested");
    expect(events).toContain("execution_finished");
  });

  it("blocks final success claims when a required push tool fails", async () => {
    const pushStep = step({
      id: "push-1",
      type: "execute",
      action: "push to wechat",
      target: "wechat",
      operation: {
        domain: "external_knowledge",
        action: "create",
        targetType: "channel",
        target: "wechat",
        selector: "wechat",
        scope: "channel",
        riskLevel: "medium",
      },
    });
    const frame = intent({
      taskType: "execute",
      needsScheduling: false,
      intentSteps: [pushStep],
      richIntent: {
        ...intent().richIntent,
        userGoal: "将上述内容推送到微信",
        domain: "external_knowledge",
      },
    });
    const plan = {
      mode: "orchestrated" as const,
      steps: [
        {
          step: pushStep,
          mode: "tool" as const,
          requiredTool: "push_to_channel",
          instruction: "Push content to the requested channel.",
          completionCriteria: "push_to_channel succeeds.",
        },
      ],
      requiredTools: ["push_to_channel"],
      completionCriteria: ["push_to_channel succeeds."],
    };
    const executor = new IntentExecutor(
      toolExecutor((request) => ({
        name: request.name,
        callId: request.callId,
        status: "failed",
        output: "❌ failed to push",
      })),
      undefined,
      { maxAttemptsPerStep: 1 },
    );

    const result = await executor.execute({
      intent: frame,
      plan,
      context: {
        userPrompt: "将上述内容推送到微信",
        currentContent: "DCF summary",
      },
    });

    expect(result.status).toBe("blocked");
    expect(result.finalResponseContract.canClaimSuccess).toBe(false);
    expect(
      executor.validateFinalResponse(result, "已经成功推送到微信。").ok,
    ).toBe(false);
    expect(
      executor.validateFinalResponse(result, "未能推送到微信，原因是通道失败。")
        .ok,
    ).toBe(true);
  });

  it("honors step dependencies and blocks dependent steps after failures", async () => {
    const first = step({ id: "first" });
    const second = step({
      id: "second",
      target: "后天早上9点提醒我检查",
      action: "后天早上9点提醒我检查",
      operation: {
        ...step().operation,
        target: "后天早上9点提醒我检查",
        selector: "后天早上9点提醒我检查",
      },
      dependsOn: ["first"],
    });
    const frame = intent({ intentSteps: [first, second] });
    const plan = buildIntentExecutionPlan(frame);
    const adapter = toolExecutor((request) => ({
      name: request.name,
      callId: request.callId,
      status: "failed",
      output: "task backend unavailable",
    }));
    const executor = new IntentExecutor(adapter, undefined, {
      maxAttemptsPerStep: 1,
    });

    const result = await executor.execute({
      intent: frame,
      plan,
      context: {
        userPrompt: "先明天早上9点提醒我复盘，再后天早上9点提醒我检查",
      },
    });

    expect(result.status).toBe("blocked");
    expect(adapter.executeTools).toHaveBeenCalledOnce();
    expect(
      result.steps.find((s) => s.executionStep.step.id === "first")?.status,
    ).toBe("blocked");
    expect(
      result.steps.find((s) => s.executionStep.step.id === "second")?.lastError,
    ).toContain("waiting for dependent step");
  });
});
