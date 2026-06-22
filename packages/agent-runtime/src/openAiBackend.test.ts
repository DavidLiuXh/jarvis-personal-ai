/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from "vitest";
import {
  OpenAiChatCompletionsBackend,
  OpenAiPromptCompiler,
} from "./openAiBackend.js";

function sse(...payloads: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const payload of payloads) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
        );
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

describe("OpenAiChatCompletionsBackend", () => {
  it("streams content and reconstructs streaming tool calls", async () => {
    const fetchFn = vi.fn(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "gpt-test",
        stream: true,
        tool_choice: "auto",
      });
      return new Response(
        sse(
          { choices: [{ delta: { content: "hello " } }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-1",
                      function: { name: "task_add", arguments: '{"title"' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: { arguments: ':"review"}' },
                    },
                  ],
                },
              },
            ],
          },
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const backend = new OpenAiChatCompletionsBackend({
      apiKey: "test-key",
      model: "gpt-test",
      fetchFn,
    });

    const events = [];
    for await (const event of backend.sendTurn(
      {
        messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }],
        tools: [{ name: "task_add", parameters: { type: "object" } }],
      },
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "content", text: "hello " },
      {
        type: "tool_call",
        request: {
          name: "task_add",
          callId: "call-1",
          args: { title: "review" },
        },
      },
    ]);
  });

  it("preserves reasoning_content for thinking-mode tool result resume", async () => {
    const backend = new OpenAiChatCompletionsBackend({
      apiKey: "test-key",
      model: "gpt-test",
      fetchFn: vi.fn(
        async () =>
          new Response(
            sse(
              { choices: [{ delta: { reasoning_content: "Need a tool. " } }] },
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call-1",
                          function: {
                            name: "recall_memory",
                            arguments: '{"query":"model"}',
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            ),
            { status: 200 },
          ),
      ) as unknown as typeof fetch,
    });

    const events = [];
    for await (const event of backend.sendTurn(
      {
        messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }],
        tools: [{ name: "recall_memory", parameters: { type: "object" } }],
      },
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "metadata",
        value: {
          openai: {
            reasoningContent: "Need a tool. ",
          },
        },
      },
      {
        type: "tool_call",
        request: {
          name: "recall_memory",
          callId: "call-1",
          args: { query: "model" },
          metadata: {
            openai: {
              reasoningContent: "Need a tool. ",
            },
          },
        },
      },
    ]);

    const compiler = new OpenAiPromptCompiler();
    expect(
      compiler.compileToolResults(
        [
          {
            name: "recall_memory",
            callId: "call-1",
            status: "success",
            output: "memory result",
          },
        ],
        [events[1].request],
      )[0],
    ).toMatchObject({
      role: "assistant",
      metadata: { openaiReasoningContent: "Need a tool. " },
    });
  });

  it("emits reasoning metadata even when the model does not emit tool calls", async () => {
    const backend = new OpenAiChatCompletionsBackend({
      apiKey: "test-key",
      model: "gpt-test",
      fetchFn: vi.fn(
        async () =>
          new Response(
            sse(
              { choices: [{ delta: { reasoning_content: "Think first. " } }] },
              { choices: [{ delta: { content: "answer" } }] },
            ),
            { status: 200 },
          ),
      ) as unknown as typeof fetch,
    });

    const events = [];
    for await (const event of backend.sendTurn(
      {
        messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }],
      },
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "content", text: "answer" },
      {
        type: "metadata",
        value: { openai: { reasoningContent: "Think first. " } },
      },
    ]);
  });

  it("sends reasoning_content back on assistant tool-call messages", async () => {
    const compiler = new OpenAiPromptCompiler();
    const messages = compiler.compileToolResults(
      [
        {
          name: "recall_memory",
          callId: "call-1",
          status: "success",
          output: "memory result",
        },
      ],
      [
        {
          name: "recall_memory",
          callId: "call-1",
          args: { query: "model" },
          metadata: {
            openai: {
              reasoningContent: "Need a tool. ",
            },
          },
        },
      ],
    );
    const fetchFn = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.messages[0]).toMatchObject({
        role: "assistant",
        reasoning_content: "Need a tool. ",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "recall_memory",
              arguments: JSON.stringify({ query: "model" }),
            },
          },
        ],
      });
      return new Response(sse({ choices: [{ delta: { content: "done" } }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const backend = new OpenAiChatCompletionsBackend({
      apiKey: "test-key",
      model: "gpt-test",
      fetchFn,
    });

    const events = [];
    for await (const event of backend.sendTurn(
      {
        messages,
      },
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(events).toEqual([{ type: "content", text: "done" }]);
  });

  it("requires an API key", () => {
    expect(
      () => new OpenAiChatCompletionsBackend({ apiKey: "", model: "gpt" }),
    ).toThrow("requires an API key");
  });

  it("compiles assistant tool calls before tool result messages", () => {
    const compiler = new OpenAiPromptCompiler();
    expect(
      compiler.compileToolResults(
        [
          {
            name: "task_add",
            callId: "call-1",
            status: "success",
            output: { ok: true },
          },
        ],
        [{ name: "task_add", callId: "call-1", args: { title: "review" } }],
      ),
    ).toEqual([
      {
        role: "assistant",
        blocks: [
          {
            type: "tool_call",
            name: "task_add",
            callId: "call-1",
            args: { title: "review" },
          },
        ],
      },
      {
        role: "tool",
        blocks: [
          {
            type: "tool_result",
            name: "task_add",
            callId: "call-1",
            result: { ok: true },
          },
        ],
      },
    ]);
  });
});
