import { describe, expect, it, vi } from "vitest";
import {
  FunctionTextGenerationBackend,
  OpenAiCompatibleTextGenerationBackend,
} from "./textGenerationBackend.js";

describe("TextGenerationBackend", () => {
  it("wraps an injected generate function", async () => {
    const backend = new FunctionTextGenerationBackend(async (prompt) =>
      prompt.toUpperCase(),
    );

    await expect(
      backend.generateText({ prompt: "hello", purpose: "test" }),
    ).resolves.toBe("HELLO");
    expect(backend.getMetadata().provider).toBe("function");
  });

  it("repairs common JSON wrapper and trailing comma issues", async () => {
    const backend = new FunctionTextGenerationBackend(async () =>
      [
        "```json",
        '{ "found": true, "links": [',
        '{ "subject": "Jarvis", "relation": "uses", "object": "runtime", },',
        "] }",
        "```",
      ].join("\n"),
    );

    await expect(
      backend.generateJson<{ links: Array<{ subject: string }> }>({
        prompt: "json",
      }),
    ).resolves.toMatchObject({
      links: [{ subject: "Jarvis" }],
    });
  });

  it("sends OpenAI-compatible chat completion requests", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "done" } }] }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const backend = new OpenAiCompatibleTextGenerationBackend({
        apiKey: "key",
        model: "model",
        baseUrl: "https://example.test/v1",
      });

      await expect(
        backend.generateText({ prompt: "return json", json: true }),
      ).resolves.toBe("done");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://example.test/v1/chat/completions",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"response_format"'),
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps backend timeout active when caller provides an AbortSignal", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn((_url, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const callerController = new AbortController();
      const backend = new OpenAiCompatibleTextGenerationBackend({
        apiKey: "key",
        model: "model",
        baseUrl: "https://example.test/v1",
        timeoutMs: 10,
      });

      const pending = backend.generateText({
        prompt: "slow",
        signal: callerController.signal,
      });
      await expect(pending).rejects.toThrow(/aborted/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
