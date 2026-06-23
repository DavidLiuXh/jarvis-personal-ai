import { describe, expect, it, vi } from "vitest";
import {
  createStandaloneBackend,
  resolveStandaloneRoutingTargetModels,
  StandaloneJarvisAgent,
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

  it("distills standalone turns into facts through runtime memory writes", async () => {
    const saveFactToRuntime = vi.fn().mockResolvedValue(undefined);
    const agent = new StandaloneJarvisAgent({
      sessionId: "session-1",
      cwd: process.cwd(),
      memoryService: {
        saveFactToRuntime,
      } as any,
      distillGenerateText: vi.fn().mockResolvedValue(
        JSON.stringify({
          found: true,
          facts: [
            {
              category: "behavior",
              content: "用户有徒步这个爱好。",
              importance: 8,
            },
          ],
        }),
      ),
    });

    await (agent as any).distillFactsInBackground(
      "我还有一个爱好是徒步",
      "好的，已记下。",
    );

    expect(saveFactToRuntime).toHaveBeenCalledWith(
      "behavior",
      "用户有徒步这个爱好。",
      expect.any(Number),
      "background_distiller",
    );
  });
});
