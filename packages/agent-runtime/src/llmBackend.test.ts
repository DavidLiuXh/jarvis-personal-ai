/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from "vitest";
import type {
  RuntimeToolRequest,
  RuntimeToolResult,
  ToolExecutorAdapter,
} from "../../intent-runtime/src/executor.js";
import {
  ToolLoopRuntime,
  type LlmBackend,
  type LlmEvent,
  type LlmMessage,
  type PromptCompiler,
  type ToolLoopPlanner,
} from "./llmBackend.js";

function backendFromTurns(turns: LlmEvent[][]): LlmBackend {
  let index = 0;
  return {
    getModel: () => "mock-backend",
    getCapabilities: () => ({
      streaming: true,
      nativeToolCalling: true,
      jsonMode: false,
      multimodalInput: false,
      maxContextTokens: 8192,
      modes: ["native_tool_calling"],
    }),
    async *sendTurn() {
      const events = turns[index++] ?? [];
      for (const event of events) yield event;
    },
  };
}

function compiler(): PromptCompiler {
  return {
    compileInitialTurn: ({ initialMessages }) => initialMessages,
    compileToolResults: (results) => [
      {
        role: "tool",
        blocks: results.map((result) => ({
          type: "tool_result" as const,
          name: result.name,
          callId: result.callId,
          result: result.output,
        })),
      },
    ],
    compileRetryPrompt: ({ reason }) => [
      { role: "user", blocks: [{ type: "text", text: reason }] },
    ],
  };
}

function toolExecutor(
  fn: (request: RuntimeToolRequest) => RuntimeToolResult,
): ToolExecutorAdapter {
  return {
    executeTools: vi.fn(async (requests) => requests.map(fn)),
  };
}

const initialMessages: LlmMessage[] = [
  { role: "user", blocks: [{ type: "text", text: "do it" }] },
];

describe("ToolLoopRuntime", () => {
  it("streams content, executes backend tool calls, and resumes with tool results", async () => {
    const request: RuntimeToolRequest = {
      name: "task_add",
      callId: "call-1",
      args: { title: "review" },
    };
    const content: string[] = [];
    const toolResults: RuntimeToolResult[] = [];
    const executor = toolExecutor((toolRequest) => ({
      name: toolRequest.name,
      callId: toolRequest.callId,
      status: "success",
      output: { ok: true },
    }));
    const runtime = new ToolLoopRuntime({
      backend: backendFromTurns([
        [{ type: "tool_call", request }],
        [{ type: "content", text: "done" }],
      ]),
      promptCompiler: compiler(),
      toolExecutor: executor,
      onContent: (text) => content.push(text),
      onToolResult: (result) => toolResults.push(result),
    });

    const result = await runtime.run({
      userPrompt: "do it",
      initialMessages,
      signal: new AbortController().signal,
    });

    expect(executor.executeTools).toHaveBeenCalledWith(
      [request],
      expect.any(AbortSignal),
    );
    expect(toolResults[0]).toMatchObject({ name: "task_add" });
    expect(content).toEqual(["done"]);
    expect(result.finalText).toBe("done");
    expect([...result.toolsCalled]).toEqual(["task_add"]);
  });

  it("deduplicates repeated backend tool call ids before execution", async () => {
    const requests: RuntimeToolRequest[] = [
      {
        name: "recall_memory",
        callId: "recall_memory",
        args: { query: "Claude" },
      },
      {
        name: "recall_memory",
        callId: "recall_memory",
        args: { query: "DeepSeek" },
      },
    ];
    const executed: RuntimeToolRequest[] = [];
    const runtime = new ToolLoopRuntime({
      backend: backendFromTurns([
        requests.map((request) => ({ type: "tool_call", request })),
        [{ type: "content", text: "done" }],
      ]),
      promptCompiler: compiler(),
      toolExecutor: toolExecutor((toolRequest) => {
        executed.push(toolRequest);
        return {
          name: toolRequest.name,
          callId: toolRequest.callId,
          status: "success",
          output: { ok: true },
        };
      }),
    });

    await runtime.run({
      userPrompt: "recall",
      initialMessages,
      signal: new AbortController().signal,
    });

    expect(executed.map((request) => request.callId)).toEqual([
      "recall_memory",
      "recall_memory-2",
    ]);
  });

  it("executes deterministic planner steps when the model omits required tools", async () => {
    const request: RuntimeToolRequest = {
      name: "push_to_channel",
      callId: "det-1",
      args: { channel: "wechat" },
    };
    let observed = false;
    const planner: ToolLoopPlanner = {
      shouldBufferPreToolContent: () => true,
      buildDeterministicToolRequests: () => (observed ? [] : [request]),
      observeToolResults: () => {
        observed = true;
      },
      buildStatePrompt: () => "tool completed",
    };
    const runtime = new ToolLoopRuntime({
      backend: backendFromTurns([
        [{ type: "content", text: "I will do that" }],
        [{ type: "content", text: "pushed" }],
      ]),
      promptCompiler: compiler(),
      toolExecutor: toolExecutor((toolRequest) => ({
        name: toolRequest.name,
        callId: toolRequest.callId,
        status: "success",
        output: { ok: true },
      })),
      planner,
    });

    const result = await runtime.run({
      userPrompt: "push it",
      initialMessages,
      signal: new AbortController().signal,
    });

    expect(result.finalText).toBe("pushed");
    expect([...result.toolsCalled]).toEqual(["push_to_channel"]);
  });

  it("propagates provider metadata to deterministic planner tool calls", async () => {
    const request: RuntimeToolRequest = {
      name: "push_to_channel",
      callId: "det-1",
      args: { channel: "wechat" },
    };
    const compiledRequests: RuntimeToolRequest[][] = [];
    let observed = false;
    const planner: ToolLoopPlanner = {
      shouldBufferPreToolContent: () => true,
      buildDeterministicToolRequests: () => (observed ? [] : [request]),
      observeToolResults: () => {
        observed = true;
      },
      buildStatePrompt: () => "tool completed",
    };
    const runtime = new ToolLoopRuntime({
      backend: backendFromTurns([
        [
          {
            type: "metadata",
            value: {
              openai: { reasoningContent: "Need deterministic tool. " },
            },
          },
          { type: "content", text: "I will do that" },
        ],
        [{ type: "content", text: "pushed" }],
      ]),
      promptCompiler: {
        ...compiler(),
        compileToolResults: (results, requests = []) => {
          compiledRequests.push(requests);
          return [
            {
              role: "tool" as const,
              blocks: results.map((result) => ({
                type: "tool_result" as const,
                name: result.name,
                callId: result.callId,
                result: result.output,
              })),
            },
          ];
        },
      },
      toolExecutor: toolExecutor((toolRequest) => ({
        name: toolRequest.name,
        callId: toolRequest.callId,
        status: "success",
        output: { ok: true },
      })),
      planner,
    });

    await runtime.run({
      userPrompt: "push it",
      initialMessages,
      signal: new AbortController().signal,
    });

    expect(compiledRequests[0][0].metadata).toEqual({
      openai: { reasoningContent: "Need deterministic tool. " },
    });
  });

  it("keeps provider metadata for suppressed synthetic tool results", async () => {
    const request: RuntimeToolRequest = {
      name: "task_add",
      callId: "call-1",
      args: { title: "review" },
    };
    const compiledRequests: RuntimeToolRequest[][] = [];
    const planner: ToolLoopPlanner = {
      filterDuplicateToolCalls: () => ({
        executableRequests: [],
        syntheticResults: [
          {
            name: "task_add",
            callId: "call-1",
            status: "success",
            output: { result: "duplicate suppressed" },
          },
        ],
      }),
    };
    const runtime = new ToolLoopRuntime({
      backend: backendFromTurns([
        [
          {
            type: "metadata",
            value: { openai: { reasoningContent: "Already did it. " } },
          },
          { type: "tool_call", request },
        ],
        [{ type: "content", text: "continued" }],
      ]),
      promptCompiler: {
        ...compiler(),
        compileToolResults: (results, requests = []) => {
          compiledRequests.push(requests);
          return [
            {
              role: "tool" as const,
              blocks: results.map((result) => ({
                type: "tool_result" as const,
                name: result.name,
                callId: result.callId,
                result: result.output,
              })),
            },
          ];
        },
      },
      toolExecutor: toolExecutor((toolRequest) => ({
        name: toolRequest.name,
        callId: toolRequest.callId,
        status: "success",
        output: { ok: true },
      })),
      planner,
    });

    await runtime.run({
      userPrompt: "do it",
      initialMessages,
      signal: new AbortController().signal,
    });

    expect(compiledRequests[0][0]).toMatchObject({
      name: "task_add",
      callId: "call-1",
      args: { title: "review" },
      metadata: { openai: { reasoningContent: "Already did it. " } },
    });
  });

  it("retries retryable backend errors and calls exhaustion hook when retries fail", async () => {
    const exhausted = vi.fn();
    const runtime = new ToolLoopRuntime({
      backend: {
        getModel: () => "mock",
        getCapabilities: () => ({
          streaming: true,
          nativeToolCalling: false,
          jsonMode: false,
          multimodalInput: false,
          maxContextTokens: null,
          modes: ["planner_only"],
        }),
        async *sendTurn() {
          throw new TypeError("fetch failed");
        },
      },
      promptCompiler: compiler(),
      toolExecutor: toolExecutor((request) => ({
        name: request.name,
        callId: request.callId,
        status: "success",
        output: {},
      })),
      maxRetries: 2,
      retryDelayMs: () => 0,
      isRetryableError: () => true,
      onRetryExhausted: exhausted,
    });

    await expect(
      runtime.run({
        userPrompt: "hello",
        initialMessages,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("fetch failed");
    expect(exhausted).toHaveBeenCalledOnce();
  });
});
