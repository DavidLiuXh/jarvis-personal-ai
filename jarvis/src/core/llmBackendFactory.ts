/**
 * Main-chat LLM backend selection for Jarvis.
 *
 * Jarvis-specific providers live here so packages/agent-runtime stays free of
 * Gemini CLI dependencies. New providers should implement the neutral
 * LlmBackend/PromptCompiler contract and be selected here by config.
 */

import {
  OpenAiChatCompletionsBackend,
  OpenAiPromptCompiler,
  type LlmBackend,
  type LlmToolSchema,
  type PromptCompiler,
} from "../agent-runtime/index.js";
import type { JarvisConfig } from "./configManager.js";
import { createDefaultRuntimeToolRegistry } from "./jarvisToolRegistry.js";

export type JarvisLlmBackendBundle = {
  provider: "openai";
  backend: LlmBackend;
  promptCompiler: PromptCompiler;
  tools: LlmToolSchema[];
};

export function normalizeToolSchema(declaration: any): LlmToolSchema | null {
  const name = declaration?.name ?? declaration?.function?.name;
  if (!name || typeof name !== "string") return null;
  return {
    name,
    description:
      declaration.description ?? declaration.function?.description ?? "",
    parameters: declaration.parameters ??
      declaration.function?.parameters ?? { type: "object", properties: {} },
  };
}

export function createJarvisLlmBackend(input: {
  config: JarvisConfig;
  promptId: string;
  tools?: LlmToolSchema[];
}): JarvisLlmBackendBundle {
  const provider = input.config.llmBackend?.provider ?? "gemini";
  if (provider !== "openai") {
    throw new Error(
      "createJarvisLlmBackend handles non-Gemini backends only. Use createGeminiJarvisLlmBackend in Gemini compatibility adapters.",
    );
  }
  const tools = (
    input.tools ??
    createDefaultRuntimeToolRegistry().listTools().map(normalizeToolSchema)
  ).filter((tool: LlmToolSchema | null): tool is LlmToolSchema =>
    Boolean(tool),
  );

  const openai = input.config.llmBackend?.openai ?? {};
  const apiKeyEnv = openai.apiKeyEnv ?? "OPENAI_API_KEY";
  const apiKey = openai.apiKey ?? process.env[apiKeyEnv] ?? "";
  return {
    provider,
    backend: new OpenAiChatCompletionsBackend({
      apiKey,
      model: openai.model ?? "gpt-4.1",
      baseUrl: openai.baseUrl,
      organization: openai.organization,
      project: openai.project,
      timeoutMs: openai.timeoutMs,
    }),
    promptCompiler: new OpenAiPromptCompiler(),
    tools,
  };
}
