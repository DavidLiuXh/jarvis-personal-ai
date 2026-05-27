/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("undici", () => ({
  Agent: vi.fn().mockImplementation(() => ({})),
  fetch: vi.fn(),
}));

import { fetch as undiciFetch } from "undici";
import {
  ollamaEmbedWithRetry,
  ollamaGenerateWithRetry,
} from "./ollamaClient.js";

const mockFetch = vi.mocked(undiciFetch);

function retryableError(): Error {
  return new Error("fetch failed");
}

describe("ollamaClient retry policy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("enforces at least 2 retries for generate calls", async () => {
    mockFetch
      .mockRejectedValueOnce(retryableError())
      .mockRejectedValueOnce(retryableError())
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: "ok" }),
      } as any);

    const result = ollamaGenerateWithRetry("gemma4:e2b", "prompt", {
      maxRetries: 0,
      timeoutMs: 100,
      purpose: "test-generate",
    });

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);

    await expect(result).resolves.toBe("ok");
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("enforces at least 2 retries for embedding calls", async () => {
    mockFetch
      .mockRejectedValueOnce(retryableError())
      .mockRejectedValueOnce(retryableError())
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embeddings: [[0.1, 0.2]] }),
      } as any);

    const result = ollamaEmbedWithRetry("bge-m3", "text", {
      maxRetries: 0,
      timeoutMs: 100,
      purpose: "test-embed",
    });

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);

    await expect(result).resolves.toEqual([0.1, 0.2]);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
