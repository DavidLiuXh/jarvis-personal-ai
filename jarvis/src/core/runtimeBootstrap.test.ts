import { describe, expect, it } from "vitest";
import { StandaloneJarvisBootstrap } from "./runtimeBootstrap.js";

describe("Runtime bootstrap", () => {
  it("can initialize a standalone Jarvis runtime boundary without Gemini client state", async () => {
    const result = await new StandaloneJarvisBootstrap({
      config: { llmBackend: { provider: "openai" } } as any,
    }).initialize();

    expect(result.mode).toBe("standalone");
    expect(result.gemini).toBeUndefined();
    expect(result.toolRegistry.getTool("task_add")).toBeTruthy();
  });
});
