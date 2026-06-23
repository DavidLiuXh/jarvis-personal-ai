import { describe, expect, it } from "vitest";
import {
  DeepSeekPromptCompiler,
  OpenAiPromptCompiler,
} from "../agent-runtime/index.js";
import type { JarvisConfig } from "./configManager.js";
import { createJarvisLlmBackend } from "./llmBackendFactory.js";

function config(provider: "gemini" | "openai" | "deepseek"): JarvisConfig {
  return {
    llmBackend: {
      provider,
      openai: {
        apiKey: "test-key",
        model: "gpt-test",
        baseUrl: "https://example.test/v1",
      },
      deepseek: {
        apiKey: "test-key",
        model: "deepseek-test",
        baseUrl: "https://deepseek.example.test",
        thinking: "disabled",
        reasoningEffort: "high",
      },
    },
  } as JarvisConfig;
}

describe("llmBackendFactory", () => {
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

  it("creates DeepSeek backend bundle from config", () => {
    const bundle = createJarvisLlmBackend({
      config: config("deepseek"),
      promptId: "p1",
    });

    expect(bundle.provider).toBe("deepseek");
    expect(bundle.backend.getModel()).toBe("deepseek-test");
    expect(bundle.promptCompiler).toBeInstanceOf(DeepSeekPromptCompiler);
    expect(bundle.tools.map((tool) => tool.name)).toContain("task_add");
    expect(bundle.tools.map((tool) => tool.name)).toContain("recall_memory");
  });
});
