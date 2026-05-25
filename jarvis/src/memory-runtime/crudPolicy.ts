/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  IntentStep,
  IntentTaskType,
  RichIntentAction,
  RichIntentDomain,
  RichIntentRiskLevel,
  RichIntentTargetType,
} from "./types.js";

export type IntentOperation = IntentStep["operation"];

export type CrudPolicyDecision = {
  ruleId: string;
  reasonCode: string;
  needsConfirmation: boolean;
  needsTime: boolean;
  needsTarget: boolean;
  defaultRiskLevel: RichIntentRiskLevel;
  requiredTool: string | null;
};

const WRITE_LIKE_ACTIONS = new Set<RichIntentAction>([
  "create",
  "update",
  "append",
  "rename",
  "delete",
  "forget",
  "pause",
  "resume",
  "cancel",
  "execute",
  "schedule",
  "send",
  "resend",
  "forward",
]);

const READ_LIKE_ACTIONS = new Set<RichIntentAction>([
  "read",
  "list",
  "recall",
  "answer",
  "analyze",
  "consolidate",
]);

function baseDecision(
  operation: IntentOperation,
  overrides: Partial<CrudPolicyDecision> = {},
): CrudPolicyDecision {
  const mutating = WRITE_LIKE_ACTIONS.has(operation.action);
  const destructive =
    operation.action === "delete" ||
    operation.action === "forget" ||
    operation.action === "cancel";
  return {
    ruleId: `${operation.domain}.${operation.action}.${operation.targetType}`,
    reasonCode: `CRUD_${operation.domain.toUpperCase()}_${operation.action.toUpperCase()}_${operation.targetType.toUpperCase()}`,
    needsConfirmation: destructive || operation.riskLevel === "high",
    needsTime: false,
    needsTarget: mutating && !READ_LIKE_ACTIONS.has(operation.action),
    defaultRiskLevel: destructive ? "high" : mutating ? "medium" : "low",
    requiredTool: null,
    ...overrides,
  };
}

export function getCrudPolicyDecision(
  operation: IntentOperation,
): CrudPolicyDecision {
  if (operation.domain === "task_management") {
    if (operation.action === "create" || operation.action === "schedule") {
      return baseDecision(operation, {
        needsConfirmation: operation.riskLevel === "high",
        needsTime: true,
        needsTarget: false,
        defaultRiskLevel: "medium",
        requiredTool: "task_add",
      });
    }
    if (operation.action === "delete" || operation.action === "cancel") {
      return baseDecision(operation, {
        needsConfirmation: true,
        needsTime: false,
        needsTarget: true,
        defaultRiskLevel: "high",
        requiredTool: "task_delete",
      });
    }
    if (operation.action === "update") {
      return baseDecision(operation, {
        needsConfirmation: true,
        needsTime: false,
        needsTarget: true,
        defaultRiskLevel: "medium",
        requiredTool: "task_update",
      });
    }
    if (operation.action === "read" || operation.action === "list") {
      return baseDecision(operation, {
        needsConfirmation: false,
        needsTime: false,
        needsTarget: false,
        defaultRiskLevel: "low",
        requiredTool: "task_list",
      });
    }
  }

  if (operation.domain === "memory_management") {
    if (operation.action === "create") {
      return baseDecision(operation, {
        needsConfirmation: operation.riskLevel === "high",
        needsTarget: true,
        defaultRiskLevel: "medium",
        requiredTool: "save_memory",
      });
    }
    if (
      operation.action === "delete" ||
      operation.action === "forget" ||
      operation.action === "update"
    ) {
      return baseDecision(operation, {
        needsConfirmation: true,
        needsTarget: true,
        defaultRiskLevel: operation.action === "update" ? "medium" : "high",
        requiredTool:
          operation.action === "update" ? "save_memory" : "memory_delete",
      });
    }
    if (operation.action === "read" || operation.action === "recall") {
      return baseDecision(operation, {
        needsConfirmation: false,
        needsTarget: false,
        defaultRiskLevel: "low",
        requiredTool: "recall_memory",
      });
    }
  }

  if (operation.domain === "code_modification") {
    if (
      operation.action === "delete" ||
      operation.action === "rename" ||
      operation.action === "update" ||
      operation.action === "append" ||
      operation.action === "create"
    ) {
      return baseDecision(operation, {
        needsConfirmation:
          operation.riskLevel === "high" || operation.action === "delete",
        needsTarget: true,
        defaultRiskLevel: operation.action === "delete" ? "high" : "medium",
        requiredTool: "appropriate_workspace_or_task_tool",
      });
    }
  }

  if (operation.domain === "system_control") {
    return baseDecision(operation, {
      needsConfirmation: operation.riskLevel !== "low",
      needsTarget: true,
      defaultRiskLevel: "medium",
      requiredTool: "appropriate_workspace_or_task_tool",
    });
  }

  if (operation.targetType === "channel") {
    return baseDecision(operation, {
      needsConfirmation: operation.riskLevel === "high",
      needsTarget: true,
      defaultRiskLevel: "medium",
      requiredTool: "push_to_channel",
    });
  }

  if (operation.action === "delegate") {
    return baseDecision(operation, {
      needsConfirmation: operation.riskLevel === "high",
      needsTarget: true,
      defaultRiskLevel: "medium",
      requiredTool: null,
    });
  }

  return baseDecision(operation);
}

export function defaultOperationForStep(args: {
  type: IntentTaskType;
  targetText: string;
  domain: RichIntentDomain;
  action: RichIntentAction;
  targetType: RichIntentTargetType;
  riskLevel: RichIntentRiskLevel;
}): IntentOperation {
  return {
    domain: args.domain,
    action: args.action,
    targetType: args.targetType,
    target: args.targetText,
    selector: args.targetText || undefined,
    scope:
      args.targetType === "memory"
        ? "long_term"
        : args.targetType === "current_context"
          ? "current_session"
          : args.targetType === "task" || args.targetType === "calendar"
            ? "scheduled_tasks"
            : args.targetType === "channel"
              ? "channel"
              : args.domain === "code_modification" ||
                  args.domain === "system_control"
                ? "workspace"
                : args.domain === "external_knowledge" ||
                    args.domain === "investment_analysis"
                  ? "external"
                  : undefined,
    riskLevel: args.riskLevel,
  };
}

export function getStepOperation(step: IntentStep): IntentOperation {
  if ((step as { operation?: IntentOperation }).operation) {
    return step.operation;
  }
  const fallbackAction: RichIntentAction =
    step.type === "recall"
      ? "recall"
      : step.type === "analyze"
        ? "analyze"
        : step.type === "schedule"
          ? /delete|remove|取消|删除|撤销/i.test(
              `${step.action} ${step.target}`,
            )
            ? "delete"
            : "create"
          : step.type === "delegate"
            ? "delegate"
            : step.type === "execute"
              ? "update"
              : "answer";
  const fallbackDomain: RichIntentDomain =
    step.type === "schedule"
      ? "task_management"
      : step.type === "recall"
        ? "memory_management"
        : step.type === "execute"
          ? "code_modification"
          : step.type === "analyze"
            ? "external_knowledge"
            : "general_chat";
  const targetType: RichIntentTargetType =
    step.type === "schedule"
      ? "task"
      : step.type === "recall"
        ? "memory"
        : step.type === "delegate"
          ? "agent"
          : step.type === "execute"
            ? "file"
            : step.type === "analyze"
              ? "external_entity"
              : "current_context";
  return defaultOperationForStep({
    type: step.type,
    targetText: step.target,
    domain: fallbackDomain,
    action: fallbackAction,
    targetType,
    riskLevel: step.riskLevel,
  });
}
