import { describe, expect, it } from "vitest";
import { resolveStandaloneOpenAiRoutingModels } from "./standaloneAgent.js";

describe("StandaloneJarvisAgent OpenAI routing models", () => {
  it("uses the default OpenAI model for both routing branches unless explicit variants are configured", () => {
    expect(
      resolveStandaloneOpenAiRoutingModels({
        llmBackend: {
          provider: "openai",
          openai: {
            model: "qwen-plus",
          },
        },
        routing: {
          enabled: true,
          model: "gemma4:e2b",
          proModel: "gemini-2.5-pro",
          flashModel: "gemini-2.5-flash",
        },
      }),
    ).toEqual({
      defaultModel: "qwen-plus",
      proModel: "qwen-plus",
      flashModel: "qwen-plus",
    });
  });

  it("uses OpenAI-compatible proModel and flashModel when configured", () => {
    expect(
      resolveStandaloneOpenAiRoutingModels({
        llmBackend: {
          provider: "openai",
          openai: {
            model: "qwen-plus",
            proModel: "qwen-max",
            flashModel: "qwen-turbo",
          },
        },
      }),
    ).toEqual({
      defaultModel: "qwen-plus",
      proModel: "qwen-max",
      flashModel: "qwen-turbo",
    });
  });
});
