/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GeminiClient } from "../../../gemini-cli/packages/core/src/index.js";
import type {
  ToolLoopPlanner,
  ToolLoopRuntimeOptions,
} from "../agent-runtime/index.js";
import type {
  RuntimeToolRequest,
  RuntimeToolResult,
  ToolExecutorAdapter,
} from "../intent-runtime/index.js";
import type { JarvisConfig } from "./configManager.js";
import type { IntentStepRuntime } from "./intentExecutionPlan.js";
import { createGeminiJarvisLlmBackend } from "./geminiLlmBackendFactory.js";
import {
  JarvisRuntimeEventType,
  runtimeFunctionResponseToToolResult,
  toolResultToRuntimeFunctionResponse,
} from "./runtimeTypes.js";
import type { ToolCallResponse, ToolRouter } from "./toolRouter.js";

export type JarvisRuntimeEmitter = (
  type: string,
  payload: unknown,
) => void | Promise<void>;

export type JarvisToolLoopRuntimeInput = {
  config: JarvisConfig;
  client: GeminiClient;
  promptId: string;
  toolRouter: ToolRouter;
  stepRuntime: IntentStepRuntime;
  maxRetries: number;
  cleanOnFailure: boolean;
  isRetryableError: (error: unknown) => boolean;
  cleanOrphanedTurn: () => void;
  emitToolCallResponse: (response: ToolCallResponse) => void;
  emitContent: (event: unknown) => void;
  log?: (message: string) => void;
};

export function createJarvisToolExecutor(input: {
  toolRouter: ToolRouter;
  emitToolCallResponse: (response: ToolCallResponse) => void;
}): ToolExecutorAdapter {
  return {
    executeTools: async (
      requests: RuntimeToolRequest[],
      signal: AbortSignal,
    ): Promise<RuntimeToolResult[]> => {
      const parts =
        requests.length > 0
          ? await input.toolRouter.route(requests, signal, (resp) =>
              input.emitToolCallResponse(resp),
            )
          : [];
      return parts
        .map((part) => runtimeFunctionResponseToToolResult(part))
        .filter((result): result is RuntimeToolResult => Boolean(result));
    },
  };
}

function toRuntimeToolRequest(request: {
  name: string;
  callId?: string;
  args?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): RuntimeToolRequest {
  return {
    name: request.name,
    callId: request.callId ?? request.name,
    args: request.args ?? {},
    ...(request.metadata ? { metadata: request.metadata } : {}),
  };
}

export function createJarvisToolLoopPlanner(input: {
  stepRuntime: IntentStepRuntime;
  toolRouter: ToolRouter;
  log?: (message: string) => void;
}): ToolLoopPlanner {
  const log = input.log ?? console.error;
  const { stepRuntime, toolRouter } = input;
  return {
    shouldBufferPreToolContent: () =>
      stepRuntime.active && stepRuntime.actionableEnforceableSteps().length > 0,
    filterDuplicateToolCalls: (requests) => {
      const duplicateDecision = stepRuntime.filterDuplicateToolCalls(requests);
      if (duplicateDecision.suppressed.length > 0) {
        log(
          `🧭 [Jarvis] Suppressed duplicate multi-intent tool call(s): ${duplicateDecision.suppressed
            .map(
              ({ request, stepId }) =>
                `${request.name}${stepId ? `@${stepId}` : ""}`,
            )
            .join(", ")}`,
        );
      }
      return {
        executableRequests:
          duplicateDecision.executableRequests.map(toRuntimeToolRequest),
        syntheticResults: duplicateDecision.duplicateResponses
          .map((part) => runtimeFunctionResponseToToolResult(part))
          .filter((result): result is RuntimeToolResult => Boolean(result)),
      };
    },
    observeToolResults: (requests, results) => {
      stepRuntime.observeToolResults(
        requests,
        results.map(toolResultToRuntimeFunctionResponse),
      );
      if (stepRuntime.active) {
        log(
          `🧭 [Jarvis] Multi-intent runtime state: ${stepRuntime
            .snapshot()
            .map(
              (entry) => `${entry.step.id}:${entry.status}/${entry.attempts}`,
            )
            .join(", ")}`,
        );
      }
    },
    buildPostContentToolRequest: (text, toolsCalled) => {
      if (toolsCalled.has("push_to_channel")) return null;
      const request = toolRouter.buildPushToChannelRequestFromContent(text);
      if (request) {
        log(
          "📤 [Jarvis] Explicit channel push request completed by generated content — invoking push_to_channel.",
        );
      }
      return request;
    },
    buildDeterministicToolRequests: () => {
      const requests = stepRuntime.buildDeterministicToolRequests();
      if (requests.length > 0) {
        log(
          `🧭 [Jarvis] Executing deterministic multi-intent step(s): ${requests
            .map((request) => request.name)
            .join(", ")}`,
        );
      }
      return requests.map(toRuntimeToolRequest);
    },
    buildMissingStepPrompt: () => stepRuntime.buildMissingStepPrompt(),
    buildStatePrompt: () => stepRuntime.buildStatePrompt(),
  };
}

export function createJarvisToolLoopOptions(
  input: JarvisToolLoopRuntimeInput,
): ToolLoopRuntimeOptions {
  const log = input.log ?? console.error;
  const networkConfig = input.config.network;
  const toolExecutor = createJarvisToolExecutor({
    toolRouter: input.toolRouter,
    emitToolCallResponse: input.emitToolCallResponse,
  });
  return {
    ...createGeminiJarvisLlmBackend({
      config: input.config,
      client: input.client,
      promptId: input.promptId,
    }),
    toolExecutor,
    maxRetries: input.maxRetries,
    maxToolIterations: networkConfig?.maxToolIterations ?? 30,
    maxConsecutiveToolFailures: networkConfig?.maxConsecutiveToolFailures ?? 3,
    maxIntentToolEnforcements: 2,
    isRetryableError: input.isRetryableError,
    onContent: (text) =>
      input.emitContent({
        type: JarvisRuntimeEventType.CONTENT,
        value: text,
      }),
    onToolCall: (request) =>
      input.emitContent({
        type: JarvisRuntimeEventType.TOOL_CALL_REQUEST,
        value: request,
      }),
    onLog: log,
    onRetryExhausted: async () => {
      if (!input.cleanOnFailure) return;
      input.cleanOrphanedTurn();
    },
    planner: createJarvisToolLoopPlanner({
      stepRuntime: input.stepRuntime,
      toolRouter: input.toolRouter,
      log,
    }),
  };
}
