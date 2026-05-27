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
