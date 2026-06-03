/**
 * Main-chat LLM backend selection for Jarvis.
 *
 * Jarvis-specific providers live here so packages/agent-runtime stays free of
 * Gemini CLI dependencies. New providers should implement the neutral
 * LlmBackend/PromptCompiler contract and be selected here by config.
 */

import type { GeminiClient } from "../../../gemini-cli/packages/core/src/index.js";
import {
  OpenAiChatCompletionsBackend,
  OpenAiPromptCompiler,
  type LlmBackend,
  type LlmToolSchema,
  type PromptCompiler,
} from "../agent-runtime/index.js";
import type { JarvisConfig } from "./configManager.js";
import {
  GeminiCliBackendAdapter,
  GeminiPromptCompiler,
} from "./geminiBackendAdapter.js";
import { createDefaultRuntimeToolRegistry } from "./jarvisToolRegistry.js";

export type JarvisLlmBackendBundle = {
  provider: "gemini" | "openai";
  backend: LlmBackend;
  promptCompiler: PromptCompiler;
  tools: LlmToolSchema[];
};

function normalizeToolSchema(declaration: any): LlmToolSchema | null {
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

export function getRuntimeToolSchemas(client: GeminiClient): LlmToolSchema[] {
  const declarations =
    (client.config as any).getToolRegistry?.().getFunctionDeclarations?.() ??
    [];
  return declarations
    .map(normalizeToolSchema)
    .filter((tool: LlmToolSchema | null): tool is LlmToolSchema =>
      Boolean(tool),
    );
}

export function createJarvisLlmBackend(input: {
  config: JarvisConfig;
  client?: GeminiClient;
  promptId: string;
  tools?: LlmToolSchema[];
}): JarvisLlmBackendBundle {
  const provider = input.config.llmBackend?.provider ?? "gemini";
  const tools = (
    input.tools ??
    createDefaultRuntimeToolRegistry().listTools().map(normalizeToolSchema)
  ).filter((tool: LlmToolSchema | null): tool is LlmToolSchema =>
    Boolean(tool),
  );

  if (provider === "openai") {
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

  return {
    provider: "gemini",
    backend: new GeminiCliBackendAdapter(
      requireGeminiClient(input.client),
      input.promptId,
    ),
    promptCompiler: new GeminiPromptCompiler(),
    tools,
  };
}

function requireGeminiClient(client: GeminiClient | undefined): GeminiClient {
  if (!client) {
    throw new Error("Gemini backend requires a GeminiClient.");
  }
  return client;
}
