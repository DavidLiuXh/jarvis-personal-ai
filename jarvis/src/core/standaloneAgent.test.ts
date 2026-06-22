import { describe, expect, it } from "vitest";
import { resolveStandaloneRoutingTargetModels } from "./standaloneAgent.js";

describe("StandaloneJarvisAgent OpenAI routing models", () => {
  it("uses the default OpenAI model for both routing branches unless routing targets are configured", () => {
    expect(
      resolveStandaloneRoutingTargetModels({
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

  it("uses backend-neutral routing targets when configured", () => {
    expect(
      resolveStandaloneRoutingTargetModels({
        llmBackend: {
          provider: "openai",
          openai: {
            model: "qwen-plus",
          },
        },
        routing: {
          enabled: true,
          model: "gemma4:e2b",
          targets: {
            pro: "qwen-max",
            flash: "qwen-turbo",
          },
          proModel: "gemini-2.5-pro",
          flashModel: "gemini-2.5-flash",
        },
      }),
    ).toEqual({
      defaultModel: "qwen-plus",
      proModel: "qwen-max",
      flashModel: "qwen-turbo",
    });
  });
});
