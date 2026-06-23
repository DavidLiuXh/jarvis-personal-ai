import { describe, expect, it, vi } from "vitest";
import {
  DeepSeekChatBackend,
  DeepSeekPromptCompiler,
} from "./deepSeekBackend.js";

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

describe("DeepSeekChatBackend", () => {
  it("sends DeepSeek thinking controls through the OpenAI-shape transport", async () => {
    const fetchFn = vi.fn(async (url, init) => {
      expect(String(url)).toBe("https://api.deepseek.com/chat/completions");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        model: "deepseek-v4-pro",
        stream: true,
        reasoning_effort: "high",
        thinking: { type: "disabled" },
      });
      return new Response(sse({ choices: [{ delta: { content: "done" } }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const backend = new DeepSeekChatBackend({
      apiKey: "test-key",
      model: "deepseek-v4-pro",
      fetchFn,
      thinking: "disabled",
      reasoningEffort: "high",
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

    expect(events).toEqual([{ type: "content", text: "done" }]);
  });
});

describe("DeepSeekPromptCompiler", () => {
  it("inherits OpenAI-shape message compilation", () => {
    const compiler = new DeepSeekPromptCompiler();
    expect(
      compiler.compileInitialTurn({
        userPrompt: "hi",
        initialMessages: [
          { role: "user", blocks: [{ type: "text", text: "hi" }] },
        ],
      }),
    ).toEqual([{ role: "user", blocks: [{ type: "text", text: "hi" }] }]);
  });
});
