/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { getCrudPolicyDecision, type IntentOperation } from "./crudPolicy.js";

function operation(overrides: Partial<IntentOperation>): IntentOperation {
  return {
    domain: "task_management",
    action: "create",
    targetType: "task",
    target: "reminder",
    selector: "reminder",
    scope: "scheduled_tasks",
    riskLevel: "medium",
    ...overrides,
  };
}

describe("getCrudPolicyDecision", () => {
  it("requires time but not an extra target for creating scheduled tasks", () => {
    const policy = getCrudPolicyDecision(
      operation({
        action: "create",
        target: "复盘投资组合",
      }),
    );

    expect(policy).toMatchObject({
      needsTime: true,
      needsTarget: false,
      needsConfirmation: false,
      requiredTool: "task_add",
    });
  });

  it("requires target and confirmation for destructive scheduled-task changes", () => {
    const policy = getCrudPolicyDecision(
      operation({
        action: "delete",
        target: "定时喝水提醒",
      }),
    );

    expect(policy).toMatchObject({
      needsTime: false,
      needsTarget: true,
      needsConfirmation: true,
      requiredTool: "task_delete",
      defaultRiskLevel: "high",
    });
  });

  it("routes memory recall and memory deletion through different contracts", () => {
    const recall = getCrudPolicyDecision(
      operation({
        domain: "memory_management",
        action: "recall",
        targetType: "memory",
        target: "conversation_history",
        scope: "long_term",
        riskLevel: "low",
      }),
    );
    const forget = getCrudPolicyDecision(
      operation({
        domain: "memory_management",
        action: "forget",
        targetType: "memory",
        target: "这条记忆",
        scope: "long_term",
        riskLevel: "high",
      }),
    );

    expect(recall).toMatchObject({
      needsConfirmation: false,
      requiredTool: "recall_memory",
    });
    expect(forget).toMatchObject({
      needsConfirmation: true,
      needsTarget: true,
      requiredTool: "memory_delete",
    });
  });

  it("maps channel send operations to push_to_channel", () => {
    const policy = getCrudPolicyDecision(
      operation({
        domain: "task_management",
        action: "send",
        targetType: "channel",
        target: "wechat",
        scope: "channel",
      }),
    );

    expect(policy).toMatchObject({
      needsTarget: true,
      requiredTool: "push_to_channel",
    });
  });
});
