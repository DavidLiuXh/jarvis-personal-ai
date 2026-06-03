/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from "vitest";
import type { IntentFrame, IntentStep } from "../memory-runtime/index.js";
import { IntentStepRuntime } from "./intentExecutionPlan.js";
import {
  createJarvisToolExecutor,
  createJarvisToolLoopOptions,
  createJarvisToolLoopPlanner,
} from "./geminiRuntimeAdapter.js";
import { JarvisRuntimeEventType } from "./runtimeTypes.js";

function step(overrides: Partial<IntentStep> = {}): IntentStep {
  return {
    id: "step-1",
    type: "schedule",
    action: "北京时间每周五下午2点分析市场",
    target: "北京时间每周五下午2点分析市场",
    operation: {
      domain: "task_management",
      action: "create",
      targetType: "task",
      target: "北京时间每周五下午2点分析市场",
      selector: "北京时间每周五下午2点分析市场",
      scope: "scheduled_tasks",
      riskLevel: "medium",
    },
    dependsOn: [],
    requiresConfirmation: false,
    riskLevel: "medium",
    ...overrides,
  };
}

function intent(): IntentFrame {
  return {
    subject: "mixed",
    taskType: "schedule",
    needsMemory: true,
    needsExternalKnowledge: true,
    needsTool: true,
    needsScheduling: true,
    candidateAgents: [],
    timeWindowDays: null,
    dateFrom: null,
    dateTo: null,
    resolvedDateRange: null,
    topicShifted: false,
    referencesRecentHistory: false,
    complexityScore: 70,
    knowledgeScore: 70,
    operationScore: 80,
    reason: "schedule market analysis",
    confidence: 0.95,
    confidenceByDimension: {
      subject: 1,
      taskType: 1,
      memoryTarget: 0.8,
      action: 1,
      entityHints: 0.8,
      topicShift: 1,
      richIntent: 1,
    },
    evidence: ["添加一个定时任务：北京时间每周五下午2点分析市场"],
    semanticEvidence: {
      personalContext: { present: false, reason: "", span: "" },
      memoryRecall: { present: false, target: "none", reason: "", span: "" },
      actionRequest: {
        present: true,
        action: "schedule",
        object: "北京时间每周五下午2点分析市场",
      },
      entityHints: { tickers: [], technicalTerms: [], peopleOrCompanies: [] },
    },
    richIntent: {
      userGoal: "添加一个定时任务：北京时间每周五下午2点分析市场",
      domain: "task_management",
      action: "create",
      primaryAction: "schedule",
      targets: [{ type: "task", value: "分析市场" }],
      contextDependency: {
        recentConversation: false,
        longTermMemory: false,
        externalWorld: true,
        localWorkspace: false,
      },
      ambiguity: [],
      riskLevel: "medium",
    },
    intentSteps: [step()],
    topicAnalysis: {
      relation: "unknown",
      history: { label: "", evidence: [], sourceTurns: [], confidence: 0 },
      current: {
        label: "scheduled market analysis",
        evidence: ["添加一个定时任务：北京时间每周五下午2点分析市场"],
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

describe("Jarvis runtime adapter", () => {
  it("routes runtime tool requests through ToolRouter and emits tool responses", async () => {
    const responsePart = {
      functionResponse: {
        id: "call-1",
        name: "task_add",
        response: { ok: true },
      },
    };
    const toolResponse = {
      name: "task_add",
      callId: "call-1",
      status: "success",
      output: { ok: true },
    };
    const toolRouter = {
      route: vi.fn(async (_requests, _signal, emit) => {
        emit(toolResponse);
        return [responsePart];
      }),
    } as any;
    const emitted: unknown[] = [];
    const executor = createJarvisToolExecutor({
      toolRouter,
      emitToolCallResponse: (part) => emitted.push(part),
    });

    const results = await executor.executeTools(
      [{ name: "task_add", callId: "call-1", args: { title: "review" } }],
      new AbortController().signal,
    );

    expect(toolRouter.route).toHaveBeenCalledOnce();
    expect(emitted).toEqual([toolResponse]);
    expect(results).toEqual([
      {
        name: "task_add",
        callId: "call-1",
        status: "success",
        output: { ok: true },
      },
    ]);
  });

  it("builds deterministic multi-intent planner requests and observes completion", () => {
    const stepRuntime = new IntentStepRuntime(intent());
    const planner = createJarvisToolLoopPlanner({
      stepRuntime,
      toolRouter: {
        buildPushToChannelRequestFromContent: () => null,
      } as any,
      log: () => {},
    });

    const requests = planner.buildDeterministicToolRequests?.() ?? [];
    expect(requests).toEqual([
      {
        name: "task_add",
        callId: "intent-step-1-task_add",
        args: {
          cron: "北京时间每周五下午2点",
          prompt: "分析市场",
        },
      },
    ]);

    planner.observeToolResults?.(requests, [
      {
        name: "task_add",
        callId: "intent-step-1-task_add",
        status: "success",
        output: { ok: true },
      },
    ]);

    expect(stepRuntime.snapshot()[0]).toMatchObject({
      status: "succeeded",
      attempts: 1,
    });
  });

  it("assembles ToolLoopRuntime options without exposing Gemini-specific loop wiring to agent.ts", () => {
    const emitted: unknown[] = [];
    const options = createJarvisToolLoopOptions({
      config: {
        network: { maxToolIterations: 12, maxConsecutiveToolFailures: 2 },
      } as any,
      client: {
        config: {
          getToolRegistry: () => ({ getFunctionDeclarations: () => [] }),
        },
        getCurrentSequenceModel: () => "gemini-test",
        getChat: () => ({ getModel: () => "gemini-chat" }),
      } as any,
      promptId: "prompt-1",
      toolRouter: {
        route: vi.fn(async () => []),
        buildPushToChannelRequestFromContent: () => null,
      } as any,
      stepRuntime: new IntentStepRuntime(null),
      maxRetries: 2,
      cleanOnFailure: false,
      isRetryableError: () => false,
      cleanOrphanedTurn: () => {},
      emitToolCallResponse: () => {},
      emitContent: (event) => emitted.push(event),
      log: () => {},
    });

    options.onContent?.("hello");
    options.onToolCall?.({ name: "task_add", callId: "call-1", args: {} });

    expect(options.maxRetries).toBe(2);
    expect(options.maxToolIterations).toBe(12);
    expect(options.maxConsecutiveToolFailures).toBe(2);
    expect(options.planner).toBeDefined();
    expect(emitted).toEqual([
      { type: JarvisRuntimeEventType.CONTENT, value: "hello" },
      {
        type: JarvisRuntimeEventType.TOOL_CALL_REQUEST,
        value: { name: "task_add", callId: "call-1", args: {} },
      },
    ]);
  });
});
