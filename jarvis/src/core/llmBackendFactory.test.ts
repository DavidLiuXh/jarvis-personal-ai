import { describe, expect, it } from "vitest";
import { OpenAiPromptCompiler } from "../agent-runtime/index.js";
import type { JarvisConfig } from "./configManager.js";
import { getRuntimeToolSchemas } from "./geminiLlmBackendFactory.js";
import { createJarvisLlmBackend } from "./llmBackendFactory.js";

function client() {
  return {
    config: {
      getToolRegistry: () => ({
        getFunctionDeclarations: () => [
          {
            name: "task_add",
            description: "Create task",
            parameters: { type: "object", properties: {} },
          },
        ],
      }),
    },
    getCurrentSequenceModel: () => "gemini",
    getChat: () => ({ getModel: () => "gemini-chat" }),
  } as any;
}

function config(provider: "gemini" | "openai"): JarvisConfig {
  return {
    llmBackend: {
      provider,
      openai: {
        apiKey: "test-key",
        model: "gpt-test",
        baseUrl: "https://example.test/v1",
      },
    },
  } as JarvisConfig;
}

describe("llmBackendFactory", () => {
  it("extracts runtime tool schemas from Gemini CLI registry declarations", () => {
    expect(getRuntimeToolSchemas(client())).toEqual([
      {
        name: "task_add",
        description: "Create task",
        parameters: { type: "object", properties: {} },
      },
    ]);
  });

  it("creates OpenAI-compatible backend bundle from config", () => {
    const bundle = createJarvisLlmBackend({
      config: config("openai"),
      promptId: "p1",
    });

    expect(bundle.provider).toBe("openai");
    expect(bundle.backend.getModel()).toBe("gpt-test");
    expect(bundle.promptCompiler).toBeInstanceOf(OpenAiPromptCompiler);
    expect(bundle.tools.map((tool) => tool.name)).toContain("task_add");
    expect(bundle.tools.map((tool) => tool.name)).toContain("recall_memory");
  });
});
