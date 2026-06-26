/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  type LlmTurnInput,
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

function recordingBackend(
  turns: LlmEvent[][],
  inputs: LlmTurnInput[],
): LlmBackend {
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
    async *sendTurn(input) {
      inputs.push(input);
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

  it("preserves repeated content chunks instead of deduplicating by substring", async () => {
    const content: string[] = [];
    const runtime = new ToolLoopRuntime({
      backend: backendFromTurns([
        [
          { type: "content", text: "## 一、概述\n" },
          { type: "content", text: "DeepSeek " },
          { type: "content", text: "DeepSeek " },
          { type: "content", text: "PPO " },
          { type: "content", text: "PPO " },
          { type: "content", text: "\\(x\\)" },
          { type: "content", text: " and " },
          { type: "content", text: "\\(x\\)" },
        ],
      ]),
      promptCompiler: compiler(),
      toolExecutor: toolExecutor((request) => ({
        name: request.name,
        callId: request.callId,
        status: "success",
        output: {},
      })),
      onContent: (text) => content.push(text),
    });

    const result = await runtime.run({
      userPrompt: "explain",
      initialMessages,
      signal: new AbortController().signal,
    });

    expect(content.join("")).toBe(
      "## 一、概述\nDeepSeek DeepSeek PPO PPO \\(x\\) and \\(x\\)",
    );
    expect(result.finalText).toBe(content.join(""));
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

  it("appends tool-call and tool-result messages when resuming stateless chat completions", async () => {
    const request: RuntimeToolRequest = {
      name: "recall_memory",
      callId: "call-1",
      args: { query: "DeepSeek" },
      metadata: { openai: { reasoningContent: "Need memory. " } },
    };
    const inputs: LlmTurnInput[] = [];
    const runtime = new ToolLoopRuntime({
      backend: recordingBackend(
        [
          [
            {
              type: "metadata",
              value: { openai: { reasoningContent: "Need memory. " } },
            },
            { type: "content", text: "Let me check." },
            { type: "tool_call", request },
          ],
          [{ type: "content", text: "final" }],
        ],
        inputs,
      ),
      promptCompiler: new (class implements PromptCompiler {
        compileInitialTurn({ initialMessages }) {
          return initialMessages;
        }
        compileToolResults(
          results: RuntimeToolResult[],
          requests: RuntimeToolRequest[] = [],
          context: { assistantContent?: string } = {},
        ) {
          return [
            {
              role: "assistant" as const,
              blocks: [
                ...(context.assistantContent
                  ? [
                      {
                        type: "text" as const,
                        text: context.assistantContent,
                      },
                    ]
                  : []),
                ...requests.map((toolRequest) => ({
                  type: "tool_call" as const,
                  name: toolRequest.name,
                  callId: toolRequest.callId,
                  args: toolRequest.args,
                })),
              ],
              metadata: {
                openaiReasoningContent: "Need memory. ",
              },
            },
            ...results.map((result) => ({
              role: "tool" as const,
              blocks: [
                {
                  type: "tool_result" as const,
                  name: result.name,
                  callId: result.callId,
                  result: result.output,
                },
              ],
            })),
          ];
        }
        compileRetryPrompt({ reason }) {
          return [
            {
              role: "user" as const,
              blocks: [{ type: "text" as const, text: reason }],
            },
          ];
        }
      })(),
      toolExecutor: toolExecutor((toolRequest) => ({
        name: toolRequest.name,
        callId: toolRequest.callId,
        status: "success",
        output: "memory result",
      })),
    });

    const result = await runtime.run({
      userPrompt: "recall",
      initialMessages,
      signal: new AbortController().signal,
    });

    expect(result.finalText).toBe("Let me check.final");
    expect(inputs[1].messages).toEqual([
      ...initialMessages,
      {
        role: "assistant",
        blocks: [
          { type: "text", text: "Let me check." },
          {
            type: "tool_call",
            name: "recall_memory",
            callId: "call-1",
            args: { query: "DeepSeek" },
          },
        ],
        metadata: { openaiReasoningContent: "Need memory. " },
      },
      {
        role: "tool",
        blocks: [
          {
            type: "tool_result",
            name: "recall_memory",
            callId: "call-1",
            result: "memory result",
          },
        ],
      },
    ]);
    expect(result.messages).toEqual([
      ...inputs[1].messages,
      { role: "assistant", blocks: [{ type: "text", text: "final" }] },
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

  it("emits full compiled prompt diagnostics before backend calls", async () => {
    const logs: string[] = [];
    const runtime = new ToolLoopRuntime({
      backend: backendFromTurns([[{ type: "content", text: "done" }]]),
      promptCompiler: {
        ...compiler(),
        compileInitialTurn: ({ systemContext, initialMessages }) => [
          {
            role: "system",
            blocks: [{ type: "text", text: systemContext ?? "" }],
          },
          ...initialMessages,
        ],
      },
      toolExecutor: toolExecutor((request) => ({
        name: request.name,
        callId: request.callId,
        status: "success",
        output: {},
      })),
      tools: [
        {
          name: "recall_memory",
          description: "Recall memory",
          parameters: { type: "object" },
        },
      ],
      promptDiagnostics: {
        enabled: true,
        label: "test-loop",
        includeTools: true,
      },
      onLog: (message) => logs.push(message),
    });

    await runtime.run({
      userPrompt: "hello",
      systemContext: "<runtime_task_artifacts>facts</runtime_task_artifacts>",
      initialMessages: [
        { role: "user", blocks: [{ type: "text", text: "hello" }] },
      ],
      signal: new AbortController().signal,
    });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("[LLMPromptDiagnostics] full_prompt ");
    const payload = JSON.parse(
      logs[0].replace("[LLMPromptDiagnostics] full_prompt ", ""),
    );
    expect(payload).toMatchObject({
      label: "test-loop",
      model: "mock-backend",
      messageCount: 2,
      tools: [expect.objectContaining({ name: "recall_memory" })],
    });
    expect(payload.messages[0]).toMatchObject({
      role: "system",
      blocks: [
        {
          type: "text",
          text: "<runtime_task_artifacts>facts</runtime_task_artifacts>",
        },
      ],
    });
    expect(payload.messages[1]).toMatchObject({
      role: "user",
      blocks: [{ type: "text", text: "hello" }],
    });
  });

  it("writes prompt diagnostics to a JSONL file when outputFile is configured", async () => {
    const logs: string[] = [];
    const outputFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "llm-prompt-diagnostics-")),
      "prompt.jsonl",
    );
    const runtime = new ToolLoopRuntime({
      backend: backendFromTurns([[{ type: "content", text: "done" }]]),
      promptCompiler: compiler(),
      toolExecutor: toolExecutor(() => ({
        name: "noop",
        callId: "noop-1",
        status: "success",
        output: {},
      })),
      promptDiagnostics: {
        enabled: true,
        label: "file-loop",
        includeTools: false,
        outputFile,
      },
      onLog: (message) => logs.push(message),
    });

    await runtime.run({
      userPrompt: "hello",
      systemContext: "system",
      initialMessages: [
        { role: "user", blocks: [{ type: "text", text: "hello" }] },
      ],
      signal: new AbortController().signal,
    });

    expect(logs).toEqual([]);
    const lines = fs.readFileSync(outputFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]);
    expect(payload).toMatchObject({
      event: "LLMPromptDiagnostics.full_prompt",
      label: "file-loop",
      model: "mock-backend",
      toolChoice: "auto",
    });
    expect(payload.timestamp).toEqual(expect.any(String));
    expect(payload.messages).toEqual(expect.any(Array));
  });
});
