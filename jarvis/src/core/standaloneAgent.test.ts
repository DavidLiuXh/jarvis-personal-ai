import { describe, expect, it } from "vitest";
import {
  createStandaloneBackend,
  resolveStandaloneRoutingTargetModels,
} from "./standaloneAgent.js";

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

  it("uses the default DeepSeek model for routing branches unless targets are configured", () => {
    expect(
      resolveStandaloneRoutingTargetModels({
        llmBackend: {
          provider: "deepseek",
          deepseek: {
            model: "deepseek-v4-pro",
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
      defaultModel: "deepseek-v4-pro",
      proModel: "deepseek-v4-pro",
      flashModel: "deepseek-v4-pro",
    });
  });

  it("passes Markdown diagnostics into the active standalone DeepSeek backend", async () => {
    const { backend } = createStandaloneBackend({
      model: "deepseek-v4-flash",
      config: {
        llmBackend: {
          provider: "deepseek",
          deepseek: {
            apiKey: "test-key",
            model: "deepseek-v4-pro",
          },
        },
        ui: {
          markdownDiagnostics: true,
          markdownDiagnosticsMaxChars: 80,
          markdownDiagnosticsChunkSampleRate: 10,
        },
      } as any,
    });

    expect((backend as any).delegate.options.diagnostics).toMatchObject({
      enabled: true,
      label: "deepseek",
      maxSnippetChars: 80,
      chunkSampleRate: 10,
    });
  });
});
