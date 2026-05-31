import { describe, expect, it } from "vitest";
import { buildIntentExecutionPlan, IntentStepRuntime } from "./index.js";
import type { IntentFrame } from "../../memory-runtime/src/index.js";

describe("@jarvis/intent-runtime package API", () => {
  it("exports execution plan and step runtime primitives", () => {
    const intent = {
      resolvedDateRange: null,
      timeWindowDays: null,
      dateFrom: null,
      dateTo: null,
      reason: "schedule request",
      evidence: ["明天早上9点提醒我复盘"],
      semanticEvidence: {
        actionRequest: {
          object: "明天早上9点提醒我复盘",
          action: "schedule",
        },
      },
      richIntent: {
        userGoal: "明天早上9点提醒我复盘",
        action: "create",
        primaryAction: "create",
        contextDependency: {
          localWorkspace: false,
        },
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
    } as IntentFrame;

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
});
