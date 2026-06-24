/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import {
  buildIntentExecutionPlan,
  IntentStepRuntime,
} from "./intentExecutionPlan.js";
import type { IntentFrame } from "./intentResolver.js";
import { buildIntentPlanSection } from "./intentPlan.js";

type TestIntentStep = Omit<IntentFrame["intentSteps"][number], "operation"> &
  Partial<Pick<IntentFrame["intentSteps"][number], "operation">>;

function intent(
  steps: TestIntentStep[],
  overrides: Partial<
    Pick<IntentFrame, "evidence" | "reason" | "richIntent" | "semanticEvidence">
  > = {},
): IntentFrame {
  const semanticEvidence: IntentFrame["semanticEvidence"] = {
    personalContext: { present: true, reason: "", span: "" },
    memoryRecall: {
      present: true,
      target: "user_memory",
      reason: "",
      span: "",
    },
    actionRequest: { present: true, action: "schedule", object: "" },
    entityHints: {
      tickers: ["NVDA"],
      technicalTerms: [],
      peopleOrCompanies: [],
    },
    ...overrides.semanticEvidence,
  };
  const richIntent: IntentFrame["richIntent"] = {
    userGoal: "analyze NVDA and schedule review",
    domain: "task_management",
    action: "schedule",
    primaryAction: "schedule",
    targets: [{ type: "external_entity", value: "NVDA" }],
    contextDependency: {
      recentConversation: false,
      longTermMemory: true,
      localWorkspace: false,
      externalWorld: true,
    },
    ambiguity: [],
    riskLevel: "medium",
    ...overrides.richIntent,
  };

  return {
    subject: "mixed",
    taskType: "schedule",
    needsMemory: true,
    needsExternalKnowledge: true,
    needsTool: true,
    needsScheduling: true,
    candidateAgents: ["investment-analysis"],
    timeWindowDays: null,
    dateFrom: null,
    dateTo: null,
    resolvedDateRange: null,
    topicShifted: false,
    referencesRecentHistory: false,
    complexityScore: 60,
    knowledgeScore: 60,
    operationScore: 60,
    reason: overrides.reason ?? "test",
    confidence: 0.8,
    confidenceByDimension: {
      subject: 0.8,
      taskType: 0.8,
      memoryTarget: 0.8,
      action: 0.8,
      entityHints: 0.8,
      topicShift: 0.8,
      richIntent: 0.8,
    },
    evidence: overrides.evidence ?? [],
    semanticEvidence,
    richIntent,
    intentSteps: steps.map((step) => ({
      ...step,
      operation: step.operation ?? {
        domain:
          step.type === "schedule" ? "task_management" : "external_knowledge",
        action: step.type === "schedule" ? "create" : "analyze",
        targetType: step.type === "schedule" ? "task" : "external_entity",
        target: step.target,
        targetId: "",
        selector: "",
        scope: step.type === "schedule" ? "scheduled_tasks" : "external",
        riskLevel: step.riskLevel,
      },
    })),
    topicAnalysis: {
      history: { label: "", evidence: [], sourceTurns: [], confidence: 0.8 },
      current: {
        label: "test",
        evidence: ["test"],
        sourceTurns: [0],
        confidence: 0.8,
      },
      relation: "unknown",
      relationReason: "",
      confidence: 0.8,
      lowGrounding: false,
    },
    source: "local-intent/ollama",
  };
}

describe("buildIntentPlanSection", () => {
  it("does not inject an intent plan for single-step requests", () => {
    const section = buildIntentPlanSection(
      intent([
        {
          id: "step-1",
          type: "analyze",
          action: "analyze external/domain context",
          target: "NVDA",
          dependsOn: [],
          requiresConfirmation: false,
          riskLevel: "low",
        },
      ]),
    );

    expect(section).toBe("");
  });

  it("formats multi-intent steps for the system prompt", () => {
    const section = buildIntentPlanSection(
      intent([
        {
          id: "step-1",
          type: "recall",
          action: "retrieve relevant user context",
          target: "risk preference",
          dependsOn: [],
          requiresConfirmation: false,
          riskLevel: "low",
        },
        {
          id: "step-2",
          type: "analyze",
          action: "analyze external/domain context",
          target: "NVDA",
          dependsOn: ["step-1"],
          requiresConfirmation: false,
          riskLevel: "low",
        },
        {
          id: "step-3",
          type: "schedule",
          action: "schedule future follow-up",
          target: "reminder",
          dependsOn: ["step-2"],
          requiresConfirmation: true,
          riskLevel: "medium",
        },
      ]),
    );

    expect(section).toContain("<intent_plan>");
    expect(section).toContain("<intent_execution_contract>");
    expect(section).toContain("mode=orchestrated");
    expect(section).toContain("required_tool=task_add");
    expect(section).toContain("[step-1] recall");
    expect(section).toContain("[step-2] analyze");
    expect(section).toContain("depends_on=step-1");
    expect(section).toContain("requires_confirmation=true");
    expect(section).toContain("Do not claim a tool-backed step is complete");
  });

  it("builds an execution contract with required tools for schedule and recall steps", () => {
    const plan = buildIntentExecutionPlan(
      intent([
        {
          id: "step-1",
          type: "recall",
          action: "retrieve relevant user context",
          target: "risk preference",
          dependsOn: [],
          requiresConfirmation: false,
          riskLevel: "low",
        },
        {
          id: "step-2",
          type: "schedule",
          action: "schedule future follow-up",
          target: "明天早上9点提醒我复盘",
          dependsOn: ["step-1"],
          requiresConfirmation: false,
          riskLevel: "medium",
        },
      ]),
    );

    expect(plan?.mode).toBe("orchestrated");
    expect(plan?.requiredTools).toEqual(expect.arrayContaining(["task_add"]));
    expect(plan?.steps.map((step) => step.mode)).toEqual(["context", "tool"]);
  });

  it("builds an execution contract for single channel push steps", () => {
    const frame = intent(
      [
        {
          id: "step-1",
          type: "execute",
          action: "push summary",
          target: "wechat",
          dependsOn: [],
          requiresConfirmation: false,
          riskLevel: "medium",
          operation: {
            domain: "task_management",
            action: "send",
            targetType: "channel",
            target: "wechat",
            targetId: "",
            selector: "wechat",
            scope: "channel",
            riskLevel: "medium",
          },
        },
      ],
      {
        richIntent: {
          userGoal: "将上述内容推送到微信",
          domain: "task_management",
          action: "send",
          primaryAction: "send",
          targets: [{ type: "channel", value: "wechat" }],
          contextDependency: {
            recentConversation: true,
            longTermMemory: false,
            localWorkspace: false,
            externalWorld: false,
          },
          ambiguity: [],
          riskLevel: "medium",
        },
      },
    );

    const plan = buildIntentExecutionPlan(frame);
    const runtime = new IntentStepRuntime(frame);

    expect(plan?.mode).toBe("orchestrated");
    expect(plan?.requiredTools).toContain("push_to_channel");
    expect(plan?.steps[0]).toMatchObject({
      mode: "tool",
      requiredTool: "push_to_channel",
    });
    expect(runtime.active).toBe(true);
    expect(runtime.buildMissingStepPrompt()).toContain("push_to_channel");
  });

  it("tracks tool-backed step state by step instead of only by tool name", () => {
    const runtime = new IntentStepRuntime(
      intent([
        {
          id: "step-1",
          type: "schedule",
          action: "schedule first follow-up",
          target: "明天早上9点提醒我复盘",
          dependsOn: [],
          requiresConfirmation: false,
          riskLevel: "medium",
        },
        {
          id: "step-2",
          type: "schedule",
          action: "schedule second follow-up",
          target: "后天早上9点提醒我检查",
          dependsOn: ["step-1"],
          requiresConfirmation: false,
          riskLevel: "medium",
        },
      ]),
    );

    runtime.observeToolResults(
      [
        {
          name: "task_add",
          args: { cron: "明天早上9点", prompt: "提醒我复盘" },
        },
      ],
      [
        {
          functionResponse: {
            name: "task_add",
            response: { result: "✅ Task added" },
          },
        },
      ],
    );

    expect(runtime.snapshot().map((entry) => entry.status)).toEqual([
      "succeeded",
      "pending",
    ]);
    expect(runtime.buildMissingStepPrompt()).toContain("step-2");
    expect(runtime.buildMissingStepPrompt()).not.toContain("step-1");
  });

  it("describes multi-intent plan and failed step reasons for observability", () => {
    const runtime = new IntentStepRuntime(
      intent([
        {
          id: "step-1",
          type: "schedule",
          action: "schedule first follow-up",
          target: "明天早上9点提醒我复盘",
          dependsOn: [],
          requiresConfirmation: false,
          riskLevel: "medium",
        },
        {
          id: "step-2",
          type: "schedule",
          action: "schedule second follow-up",
          target: "后天早上9点提醒我检查",
          dependsOn: ["step-1"],
          requiresConfirmation: false,
          riskLevel: "medium",
        },
      ]),
      { maxAttemptsPerStep: 2 },
    );

    expect(runtime.describePlan()).toContain("step-1:");
    expect(runtime.describePlan()).toContain("tool=task_add");
    expect(runtime.describePlan()).toContain("deps=step-1");
    expect(runtime.describePlan()).toContain("initial_state=pending_execution");
    expect(runtime.describePlan()).not.toContain("status=succeeded");
    expect(runtime.describeInitialStateSummary()).toContain(
      "step-1:pending_execution",
    );

    runtime.observeToolResults(
      [
        {
          name: "task_add",
          args: { cron: "明天早上9点", prompt: "提醒我复盘" },
        },
      ],
      [
        {
          functionResponse: {
            name: "task_add",
            response: { error: "scheduler unavailable" },
          },
        },
      ],
    );

    expect(runtime.describeFailures()).toEqual([
      'step-1: status=failed attempts=1/2 reason="scheduler unavailable" next=will_retry_if_prompted',
      'step-2: status=pending attempts=0/2 reason="waiting for dependent step(s): step-1" next=waiting_for_dependency',
    ]);

    runtime.observeToolResults(
      [
        {
          name: "task_add",
          args: { cron: "明天早上9点", prompt: "提醒我复盘" },
        },
      ],
      [
        {
          functionResponse: {
            name: "task_add",
            response: { error: "scheduler still unavailable" },
          },
        },
      ],
    );

    expect(runtime.describeFailures()[0]).toContain("status=blocked");
    expect(runtime.describeFailures()[0]).toContain(
      'reason="scheduler still unavailable"',
    );
    expect(runtime.describeFailures()[0]).toContain("next=request_blocked");
    expect(runtime.describeFailures()[1]).toContain(
      "next=waiting_for_dependency",
    );
  });

  it("labels non-tool initial steps as auto_satisfied in pre-execution plan logs", () => {
    const runtime = new IntentStepRuntime(
      intent([
        {
          id: "step-1",
          type: "recall",
          action: "recall current context",
          target: "recent discussion",
          dependsOn: [],
          requiresConfirmation: false,
          riskLevel: "low",
        },
        {
          id: "step-2",
          type: "schedule",
          action: "schedule follow-up",
          target: "明天早上9点提醒我复盘",
          dependsOn: ["step-1"],
          requiresConfirmation: false,
          riskLevel: "medium",
        },
      ]),
    );

    expect(runtime.describeInitialStateSummary()).toContain(
      "step-1:auto_satisfied",
    );
    expect(runtime.describeInitialStateSummary()).toContain(
      "step-2:pending_execution",
    );
    expect(runtime.describePlan()).toContain("initial_state=auto_satisfied");
    expect(runtime.describePlan()).not.toContain("step-1: status=succeeded");
  });

  it("describes why multi-intent runtime is skipped", () => {
    expect(new IntentStepRuntime(null).describeSkipReason()).toBe("no_intent");
    expect(new IntentStepRuntime(intent([])).describeSkipReason()).toBe(
      "no_steps",
    );
    expect(
      new IntentStepRuntime(
        intent([
          {
            id: "step-1",
            type: "analyze",
            action: "answer directly",
            target: "文昌帝君",
            dependsOn: [],
            requiresConfirmation: false,
            riskLevel: "low",
          },
        ]),
      ).describeSkipReason(),
    ).toBe("single_llm_step");
    expect(
      new IntentStepRuntime(
        intent([
          {
            id: "step-1",
            type: "recall",
            action: "recall context",
            target: "recent discussion",
            dependsOn: [],
            requiresConfirmation: false,
            riskLevel: "low",
          },
          {
            id: "step-2",
            type: "analyze",
            action: "answer directly",
            target: "current question",
            dependsOn: ["step-1"],
            requiresConfirmation: false,
            riskLevel: "low",
          },
        ]),
      ).describeSkipReason(),
    ).toBe("active");
  });

  it("suppresses dependent tool calls until prerequisite steps succeed", () => {
    const runtime = new IntentStepRuntime(
      intent([
        {
          id: "step-1",
          type: "schedule",
          action: "schedule first follow-up",
          target: "明天早上9点提醒我复盘",
          dependsOn: [],
          requiresConfirmation: false,
          riskLevel: "medium",
        },
        {
          id: "step-2",
          type: "schedule",
          action: "schedule second follow-up",
          target: "后天早上9点提醒我检查",
          dependsOn: ["step-1"],
          requiresConfirmation: false,
          riskLevel: "medium",
        },
      ]),
    );

    const first = {
      name: "task_add",
      args: { cron: "明天早上9点", prompt: "提醒我复盘" },
    };
    const second = {
      name: "task_add",
      args: { cron: "后天早上9点", prompt: "提醒我检查" },
    };

    const blocked = runtime.filterDuplicateToolCalls([second]);
    expect(blocked.executableRequests).toEqual([]);
    expect(blocked.suppressed[0]).toMatchObject({
      stepId: "step-2",
      reason: "waiting for dependent step(s): step-1",
    });

    const allowed = runtime.filterDuplicateToolCalls([first]);
    expect(allowed.executableRequests).toEqual([first]);
    expect(runtime.snapshot()[0]?.status).toBe("running");

    runtime.observeToolResults(
      [first],
      [
        {
          functionResponse: {
            name: "task_add",
            response: { result: "✅ Task added" },
          },
        },
      ],
    );

    const unblocked = runtime.filterDuplicateToolCalls([second]);
    expect(unblocked.executableRequests).toEqual([second]);
  });

  it("does not report runtime changes for unrelated tool results", () => {
    const runtime = new IntentStepRuntime(
      intent([
        {
          id: "step-1",
          type: "recall",
          action: "recall current context",
          target: "recent discussion",
          dependsOn: [],
          requiresConfirmation: false,
          riskLevel: "low",
        },
        {
          id: "step-2",
          type: "analyze",
          action: "answer from current context",
          target: "current question",
          dependsOn: ["step-1"],
          requiresConfirmation: false,
          riskLevel: "low",
        },
      ]),
    );

    const changed = runtime.observeToolResults(
      [
        {
          name: "recall_memory",
          callId: "unrelated",
          args: { query: "anything" },
        },
      ],
      [
        {
          functionResponse: {
            name: "recall_memory",
            response: { result: "memory result" },
          },
        },
      ],
    );

    expect(changed).toBe(false);
    expect(
      runtime.snapshot().map((entry) => `${entry.status}/${entry.attempts}`),
    ).toEqual(["succeeded/0", "succeeded/0"]);
  });

  it("suppresses duplicate tool calls for a completed step", () => {
    const runtime = new IntentStepRuntime(
      intent([
        {
          id: "step-1",
          type: "schedule",
          action: "schedule future follow-up",
          target: "明天早上9点提醒我复盘",
          dependsOn: [],
          requiresConfirmation: false,
          riskLevel: "medium",
        },
        {
          id: "step-2",
          type: "analyze",
          action: "analyze external/domain context",
          target: "NVDA",
          dependsOn: ["step-1"],
          requiresConfirmation: false,
          riskLevel: "low",
        },
      ]),
    );
    const request = {
      name: "task_add",
      callId: "call-task-add-1",
      args: { cron: "明天早上9点", prompt: "提醒我复盘" },
    };

    runtime.observeToolResults(
      [request],
      [
        {
          functionResponse: {
            name: "task_add",
            response: { result: "✅ Task added" },
          },
        },
      ],
    );

    const decision = runtime.filterDuplicateToolCalls([request]);

    expect(decision.executableRequests).toHaveLength(0);
    expect(decision.duplicateResponses).toHaveLength(1);
    expect(decision.duplicateResponses[0].functionResponse?.id).toBe(
      request.callId,
    );
    expect(JSON.stringify(decision.duplicateResponses[0])).toContain(
      "Duplicate tool call suppressed",
    );
  });

  it("builds deterministic task_add requests for concrete schedule steps", () => {
    const runtime = new IntentStepRuntime(
      intent([
        {
          id: "step-1",
          type: "schedule",
          action: "schedule future follow-up",
          target: "明天早上9点提醒我复盘",
          dependsOn: [],
          requiresConfirmation: false,
          riskLevel: "medium",
        },
        {
          id: "step-2",
          type: "analyze",
          action: "analyze external/domain context",
          target: "NVDA",
          dependsOn: ["step-1"],
          requiresConfirmation: false,
          riskLevel: "low",
        },
      ]),
    );

    expect(runtime.buildDeterministicToolRequests()).toEqual([
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

  it("builds task_add cron and prompt from full intent evidence for scheduled workflows", () => {
    const userRequest =
      "添加一个定时任务：北京时间每周五下午2点，使用dmii框架分析美国市场行情及趋势，保存成本地的markdown文件";
    const runtime = new IntentStepRuntime(
      intent(
        [
          {
            id: "step-1",
            type: "analyze",
            action: "使用dmii框架分析",
            target: "美国市场行情及趋势",
            dependsOn: [],
            requiresConfirmation: false,
            riskLevel: "medium",
          },
          {
            id: "step-2",
            type: "execute",
            action: "保存成本地markdown文件",
            target: "美国市场行情及趋势分析报告",
            dependsOn: ["step-1"],
            requiresConfirmation: false,
            riskLevel: "medium",
          },
          {
            id: "step-3",
            type: "schedule",
            action: "添加定时任务",
            target: "美国市场行情及趋势分析报告",
            dependsOn: ["step-2"],
            requiresConfirmation: false,
            riskLevel: "medium",
          },
        ],
        {
          evidence: [userRequest],
          richIntent: {
            userGoal: userRequest,
            domain: "task_management",
            action: "schedule",
            primaryAction: "schedule",
            targets: [{ type: "external_entity", value: "美国市场" }],
            contextDependency: {
              recentConversation: false,
              longTermMemory: true,
              localWorkspace: true,
              externalWorld: true,
            },
            ambiguity: [],
            riskLevel: "medium",
          },
          semanticEvidence: {
            personalContext: { present: true, reason: "", span: "" },
            memoryRecall: {
              present: false,
              target: "none",
              reason: "",
              span: "",
            },
            actionRequest: {
              present: true,
              action: "schedule",
              object: userRequest,
            },
            entityHints: {
              tickers: [],
              technicalTerms: ["DMII"],
              peopleOrCompanies: [],
            },
          },
        },
      ),
    );

    expect(runtime.buildDeterministicToolRequests()).toEqual([
      {
        name: "task_add",
        callId: "intent-step-3-task_add",
        args: {
          cron: "北京时间每周五下午2点",
          prompt:
            "使用dmii框架分析美国市场行情及趋势，保存成本地的markdown文件",
        },
      },
    ]);
  });

  it("does not emit deterministic task_add calls without concrete schedule time", () => {
    const runtime = new IntentStepRuntime(
      intent([
        {
          id: "step-1",
          type: "schedule",
          action: "schedule future follow-up",
          target: "提醒我复盘",
          dependsOn: [],
          requiresConfirmation: false,
          riskLevel: "medium",
        },
        {
          id: "step-2",
          type: "analyze",
          action: "analyze external/domain context",
          target: "NVDA",
          dependsOn: ["step-1"],
          requiresConfirmation: false,
          riskLevel: "low",
        },
      ]),
    );

    expect(runtime.buildDeterministicToolRequests()).toEqual([]);
  });
});
