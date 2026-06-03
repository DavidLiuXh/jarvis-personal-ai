import { describe, expect, it, vi } from "vitest";

vi.mock("./geminiRuntimeBootstrap.js", () => ({
  GeminiRuntimeBootstrap: class GeminiRuntimeBootstrap {
    constructor(public readonly options: unknown) {}
    async initialize() {
      throw new Error("not used");
    }
  },
}));

import {
  createRuntimeBootstrap,
  shouldUseStandaloneRuntime,
} from "./runtimeBootstrapFactory.js";
import { GeminiRuntimeBootstrap } from "./geminiRuntimeBootstrap.js";
import { StandaloneJarvisBootstrap } from "./runtimeBootstrap.js";

const baseInput = {
  sessionId: "s1",
  sourceRoot: "/tmp",
  memoryService: {} as any,
  dynamicRegistry: { getDynamicToolSchemas: vi.fn().mockReturnValue([]) },
  onSubagentActivity: vi.fn(),
};

describe("runtime bootstrap factory", () => {
  it("selects standalone runtime for OpenAI-compatible backend", () => {
    const config = { llmBackend: { provider: "openai" } } as any;

    expect(shouldUseStandaloneRuntime(config)).toBe(true);
    expect(createRuntimeBootstrap({ ...baseInput, config })).toBeInstanceOf(
      StandaloneJarvisBootstrap,
    );
  });

  it("keeps Gemini compatibility runtime as the default", () => {
    const config = { llmBackend: { provider: "gemini" } } as any;

    expect(shouldUseStandaloneRuntime(config)).toBe(false);
    expect(createRuntimeBootstrap({ ...baseInput, config })).toBeInstanceOf(
      GeminiRuntimeBootstrap,
    );
  });
});
