/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MemoryService } from "./memory.js";
import { AgentInitializer } from "./agentInitializer.js";
import { ConfigManager, type JarvisConfig } from "./configManager.js";
import {
  createDefaultRuntimeToolRegistry,
  type RuntimeToolRegistry,
} from "./jarvisToolRegistry.js";
import { createGeminiToolInteractionRecorder } from "./geminiToolInteractionRecorder.js";
import type {
  RuntimeBootstrap,
  RuntimeBootstrapResult,
} from "./runtimeBootstrap.js";

type DynamicRegistryHandle = {
  getDynamicToolSchemas: () => unknown[];
};

export class GeminiRuntimeBootstrap implements RuntimeBootstrap {
  private readonly toolRegistry: RuntimeToolRegistry;
  private readonly config: JarvisConfig;

  constructor(
    private readonly options: {
      sessionId: string;
      sourceRoot: string;
      memoryService: MemoryService;
      dynamicRegistry: DynamicRegistryHandle;
      skipResume?: boolean;
      onSubagentActivity: (message: unknown) => void;
      config?: JarvisConfig;
      toolRegistry?: RuntimeToolRegistry;
    },
  ) {
    this.config = options.config ?? ConfigManager.getInstance().get();
    this.toolRegistry =
      options.toolRegistry ?? createDefaultRuntimeToolRegistry();
  }

  async initialize(): Promise<RuntimeBootstrapResult> {
    const initializer = new AgentInitializer(
      this.options.sessionId,
      this.options.sourceRoot,
      this.options.memoryService,
      this.options.dynamicRegistry,
      this.options.skipResume ?? false,
    );
    const result = await initializer.initialize(
      this.options.onSubagentActivity,
    );
    return {
      mode: "gemini-compat",
      config: this.config,
      toolRegistry: this.toolRegistry,
      toolInteractionRecorder: createGeminiToolInteractionRecorder(),
      gemini: {
        config: initializer.getCompatibilityConfig(),
        client: result.client,
        scheduler: result.scheduler,
      },
    };
  }
}
