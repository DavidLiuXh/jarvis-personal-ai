/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { GeminiEventType } from "../../../gemini-cli/packages/core/src/index.js";
import {
  GeminiCliBackendAdapter,
  GeminiPromptCompiler,
  geminiPartToRuntimeToolResult,
  geminiPartsToLlmMessages,
  runtimeToolResultToGeminiPart,
} from "./geminiBackendAdapter.js";

function mockGeminiClient(events: any[]) {
  const calls: any[] = [];
  return {
    calls,
    getCurrentSequenceModel: () => "gemini-test",
    getChat: () => ({ getModel: () => "gemini-chat" }),
    async *sendMessageStream(
      parts: any[],
      signal: AbortSignal,
      promptId: string,
    ) {
      calls.push({ parts, signal, promptId });
      for (const event of events) yield event;
    },
  } as any;
}

describe("Gemini backend adapter", () => {
  it("translates neutral messages into Gemini parts and emits neutral events", async () => {
    const request = {
      name: "task_add",
      callId: "call-1",
      args: { title: "review" },
    };
    const client = mockGeminiClient([
      { type: GeminiEventType.Content, value: "hello" },
      { type: GeminiEventType.ToolCallRequest, value: request },
    ]);
    const backend = new GeminiCliBackendAdapter(client, "prompt-1");

    const events = [];
    for await (const event of backend.sendTurn(
      {
        messages: [
          {
            role: "user",
            blocks: [
              { type: "text", text: "hi" },
              { type: "inline_data", mimeType: "image/png", data: "abc" },
            ],
          },
        ],
      },
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(client.calls[0].promptId).toBe("prompt-1");
    expect(client.calls[0].parts).toEqual([
      { text: "hi" },
      { inlineData: { mimeType: "image/png", data: "abc" } },
    ]);
    expect(events).toEqual([
      { type: "content", text: "hello" },
      { type: "tool_call", request },
    ]);
  });

  it("round-trips Gemini functionResponse parts through runtime tool results", () => {
    const part = runtimeToolResultToGeminiPart({
      name: "push_to_channel",
      callId: "call-2",
      status: "success",
      output: { result: "sent" },
    });

    expect(geminiPartToRuntimeToolResult(part)).toEqual({
      name: "push_to_channel",
      callId: "call-2",
      status: "success",
      output: { result: "sent" },
    });
  });

  it("compiles initial and tool-result messages without exposing Gemini Part[] to runtime", () => {
    const compiler = new GeminiPromptCompiler();
    expect(
      compiler.compileInitialTurn({
        userPrompt: "hello",
        systemContext: "system",
        initialMessages: geminiPartsToLlmMessages([{ text: "hello" } as any]),
      }),
    ).toEqual([
      { role: "system", blocks: [{ type: "text", text: "system" }] },
      { role: "user", blocks: [{ type: "text", text: "hello" }] },
    ]);
    expect(
      compiler.compileToolResults([
        {
          name: "task_add",
          callId: "call-3",
          status: "success",
          output: { ok: true },
        },
      ]),
    ).toEqual([
      {
        role: "tool",
        blocks: [
          {
            type: "tool_result",
            name: "task_add",
            callId: "call-3",
            result: { ok: true },
          },
        ],
      },
    ]);
  });
});
