/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ollamaGenerateWithRetry } from "./ollamaClient.js";

export type TextGenerationRequest = {
  prompt: string;
  purpose?: string;
  signal?: AbortSignal;
  json?: boolean;
};

export type TextGenerationMetadata = {
  provider: string;
  model?: string;
};

export interface TextGenerationBackend {
  generateText(request: TextGenerationRequest): Promise<string>;
  generateJson<T = unknown>(request: TextGenerationRequest): Promise<T>;
  getMetadata(): TextGenerationMetadata;
}

function parseJsonResponse<T>(text: string): T {
  const repairCandidates = (raw: string): string[] => {
    const trimmed = raw.trim();
    const trailingCommaFixed = trimmed
      .replace(/,\s*]/g, "]")
      .replace(/,\s*}/g, "}");
    const collapsedNewlines = trailingCommaFixed.replace(/\n/g, " ");
    const linksStart = collapsedNewlines.indexOf('"links"');
    const lastCompleteObject = collapsedNewlines.lastIndexOf("}");
    const truncatedLinksFixed =
      linksStart >= 0 && lastCompleteObject >= 0
        ? `${collapsedNewlines.substring(0, lastCompleteObject + 1)}]}`
        : collapsedNewlines;
    return [
      trimmed,
      trailingCommaFixed,
      collapsedNewlines,
      truncatedLinksFixed,
    ].filter((candidate, index, all) => all.indexOf(candidate) === index);
  };
  const parseCandidates = (raw: string): T | null => {
    for (const candidate of repairCandidates(raw)) {
      try {
        return JSON.parse(candidate) as T;
      } catch {
        // try next repair candidate
      }
    }
    return null;
  };

  const direct = parseCandidates(text);
  if (direct !== null) return direct;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    const parsed = parseCandidates(fenced);
    if (parsed !== null) return parsed;
  }

  const objectStart = text.indexOf("{");
  const objectEnd = text.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    const parsed = parseCandidates(text.slice(objectStart, objectEnd + 1));
    if (parsed !== null) return parsed;
  }

  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    const parsed = parseCandidates(text.slice(arrayStart, arrayEnd + 1));
    if (parsed !== null) return parsed;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("No valid JSON payload in text generation response.");
  }
}

function composeAbortSignals(
  signals: Array<AbortSignal | undefined>,
): AbortSignal {
  const activeSignals = signals.filter((signal): signal is AbortSignal =>
    Boolean(signal),
  );
  if (activeSignals.length === 1) return activeSignals[0];
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of activeSignals) {
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

export class FunctionTextGenerationBackend implements TextGenerationBackend {
  constructor(
    private readonly generate: (prompt: string) => Promise<string>,
    private readonly metadata: TextGenerationMetadata = {
      provider: "function",
    },
  ) {}

  async generateText(request: TextGenerationRequest): Promise<string> {
    return this.generate(request.prompt);
  }

  async generateJson<T = unknown>(request: TextGenerationRequest): Promise<T> {
    return parseJsonResponse<T>(
      await this.generateText({ ...request, json: true }),
    );
  }

  getMetadata(): TextGenerationMetadata {
    return this.metadata;
  }
}

export class OllamaTextGenerationBackend implements TextGenerationBackend {
  constructor(
    private readonly options: {
      model: string;
      baseUrl?: string;
      timeoutMs?: number;
      maxRetries?: number;
      numCtx?: number;
    },
  ) {}

  async generateText(request: TextGenerationRequest): Promise<string> {
    return ollamaGenerateWithRetry(this.options.model, request.prompt, {
      baseUrl: this.options.baseUrl,
      timeoutMs: this.options.timeoutMs,
      maxRetries: this.options.maxRetries ?? 2,
      maxTimeoutMs: (this.options.timeoutMs ?? 120_000) * 3,
      numCtx: this.options.numCtx,
      purpose: request.purpose,
    });
  }

  async generateJson<T = unknown>(request: TextGenerationRequest): Promise<T> {
    return parseJsonResponse<T>(
      await this.generateText({ ...request, json: true }),
    );
  }

  getMetadata(): TextGenerationMetadata {
    return { provider: "ollama", model: this.options.model };
  }
}

export class OpenAiCompatibleTextGenerationBackend
  implements TextGenerationBackend
{
  constructor(
    private readonly options: {
      apiKey: string;
      model: string;
      baseUrl?: string;
      organization?: string;
      project?: string;
      timeoutMs?: number;
      maxRetries?: number;
    },
  ) {}

  async generateText(request: TextGenerationRequest): Promise<string> {
    if (!this.options.apiKey) {
      throw new Error("OpenAI-compatible text backend requires an API key.");
    }
    const maxRetries = this.options.maxRetries ?? 2;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.options.timeoutMs ?? 120_000,
      );
      const signal = composeAbortSignals([request.signal, controller.signal]);
      try {
        const response = await fetch(
          `${this.options.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.options.apiKey}`,
              "Content-Type": "application/json",
              ...(this.options.organization
                ? { "OpenAI-Organization": this.options.organization }
                : {}),
              ...(this.options.project
                ? { "OpenAI-Project": this.options.project }
                : {}),
            },
            body: JSON.stringify({
              model: this.options.model,
              messages: [{ role: "user", content: request.prompt }],
              ...(request.json
                ? { response_format: { type: "json_object" } }
                : {}),
            }),
            signal,
          },
        );
        if (!response.ok) {
          throw new Error(
            `OpenAI-compatible text backend failed: ${response.status} ${await response.text()}`,
          );
        }
        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        return data.choices?.[0]?.message?.content ?? "";
      } catch (error) {
        lastError = error;
        if (request.signal?.aborted || attempt >= maxRetries) {
          throw error;
        }
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async generateJson<T = unknown>(request: TextGenerationRequest): Promise<T> {
    return parseJsonResponse<T>(
      await this.generateText({ ...request, json: true }),
    );
  }

  getMetadata(): TextGenerationMetadata {
    return { provider: "openai-compatible", model: this.options.model };
  }
}
