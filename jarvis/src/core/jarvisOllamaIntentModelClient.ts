/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  IntentModelClient,
  IntentModelClientRequest,
} from "../memory-runtime/adapters.js";
import { ollamaGenerateWithRetry } from "./ollamaClient.js";

export type JarvisOllamaIntentModelClientOptions = {
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
};

export class JarvisOllamaIntentModelClient implements IntentModelClient {
  constructor(private readonly options: JarvisOllamaIntentModelClientOptions) {}

  async generateJson(input: IntentModelClientRequest): Promise<string> {
    const prompt = input.system
      ? `${input.system.trim()}\n\n${input.prompt}`
      : input.prompt;
    return ollamaGenerateWithRetry(this.options.model, prompt, {
      baseUrl: this.options.baseUrl ?? "http://localhost:11434",
      timeoutMs: input.timeoutMs ?? this.options.timeoutMs ?? 30_000,
      format: input.responseFormat === "json" ? "json" : undefined,
      numCtx: input.contextWindow,
      numPredict: input.maxOutputTokens,
      temperature: input.temperature,
      purpose: "intent-resolver",
    });
  }
}
