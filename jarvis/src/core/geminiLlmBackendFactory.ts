/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GeminiClient } from "../../../gemini-cli/packages/core/src/index.js";
import type {
  LlmBackend,
  LlmToolSchema,
  PromptCompiler,
} from "../agent-runtime/index.js";
import type { JarvisConfig } from "./configManager.js";
import {
  GeminiCliBackendAdapter,
  GeminiPromptCompiler,
} from "./geminiBackendAdapter.js";
import { createDefaultRuntimeToolRegistry } from "./jarvisToolRegistry.js";
import { normalizeToolSchema } from "./llmBackendFactory.js";

export type GeminiJarvisLlmBackendBundle = {
  provider: "gemini";
  backend: LlmBackend;
  promptCompiler: PromptCompiler;
  tools: LlmToolSchema[];
};

export function getRuntimeToolSchemas(client: GeminiClient): LlmToolSchema[] {
  const declarations =
    ((client as any).config as any)
      .getToolRegistry?.()
      .getFunctionDeclarations?.() ?? [];
  return declarations
    .map(normalizeToolSchema)
    .filter((tool: LlmToolSchema | null): tool is LlmToolSchema =>
      Boolean(tool),
    );
}

export function createGeminiJarvisLlmBackend(input: {
  config: JarvisConfig;
  client: GeminiClient;
  promptId: string;
  tools?: LlmToolSchema[];
}): GeminiJarvisLlmBackendBundle {
  const tools = (
    input.tools ??
    createDefaultRuntimeToolRegistry().listTools().map(normalizeToolSchema)
  ).filter((tool: LlmToolSchema | null): tool is LlmToolSchema =>
    Boolean(tool),
  );
  return {
    provider: "gemini",
    backend: new GeminiCliBackendAdapter(input.client, input.promptId),
    promptCompiler: new GeminiPromptCompiler(),
    tools,
  };
}
