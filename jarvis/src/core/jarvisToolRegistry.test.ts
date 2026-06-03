import { describe, expect, it } from "vitest";
import {
  addToolsToGeminiRegistry,
  createDefaultRuntimeToolRegistry,
  createJarvisNativeToolSchemas,
} from "./jarvisToolRegistry.js";

describe("Jarvis runtime tool registry", () => {
  it("owns Jarvis native tool schemas independent of Gemini CLI", () => {
    const registry = createDefaultRuntimeToolRegistry();
    const names = registry.listTools().map((tool) => tool.name);

    expect(names).toContain("recall_memory");
    expect(names).toContain("task_add");
    expect(names).toContain("push_to_channel");
    expect(registry.getTool("task_delete")?.riskLevel).toBe("high");
  });

  it("can mirror Jarvis-owned schemas into a Gemini-compatible registry", () => {
    const added: string[] = [];
    addToolsToGeminiRegistry(
      {
        addDiscoveredTool(tool: { name: string }) {
          added.push(tool.name);
        },
      },
      createJarvisNativeToolSchemas(),
    );

    expect(added).toContain("recall_memory");
    expect(added).toContain("task_add");
    expect(added).toContain("push_to_channel");
  });
});
