/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MemoryService } from "./memory.js";
import { ConfigManager, type JarvisConfig } from "./configManager.js";
import { GeminiRuntimeBootstrap } from "./geminiRuntimeBootstrap.js";
import {
  StandaloneJarvisBootstrap,
  type RuntimeBootstrap,
} from "./runtimeBootstrap.js";

type RuntimeBootstrapFactoryInput = {
  sessionId: string;
  sourceRoot: string;
  memoryService: MemoryService;
  dynamicRegistry: { getDynamicToolSchemas: () => unknown[] };
  skipResume?: boolean;
  onSubagentActivity: (message: unknown) => void;
  config?: JarvisConfig;
};

export function shouldUseStandaloneRuntime(config: JarvisConfig): boolean {
  return config.llmBackend?.provider === "openai";
}

export function createRuntimeBootstrap(
  input: RuntimeBootstrapFactoryInput,
): RuntimeBootstrap {
  const config = input.config ?? ConfigManager.getInstance().get();
  if (shouldUseStandaloneRuntime(config)) {
    return new StandaloneJarvisBootstrap({ config });
  }
  return new GeminiRuntimeBootstrap({
    ...input,
    config,
  });
}
