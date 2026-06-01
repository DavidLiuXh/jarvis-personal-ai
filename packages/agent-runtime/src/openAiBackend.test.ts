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
