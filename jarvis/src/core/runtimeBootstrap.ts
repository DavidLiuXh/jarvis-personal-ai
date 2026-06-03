/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { JarvisConfig } from "./configManager.js";
import {
  DefaultJarvisRuntimeConfigProvider,
  type JarvisRuntimeConfigProvider,
} from "./jarvisRuntimeConfig.js";
import {
  createDefaultRuntimeToolRegistry,
  type RuntimeToolRegistry,
} from "./jarvisToolRegistry.js";
import type { ToolInteractionRecorder } from "./toolRouter.js";

export type RuntimeBootstrapMode = "standalone" | "gemini-compat";

export type RuntimeBootstrapResult = {
  mode: RuntimeBootstrapMode;
  config: JarvisConfig;
  toolRegistry: RuntimeToolRegistry;
  toolInteractionRecorder?: ToolInteractionRecorder;
  gemini?: {
    config: unknown;
    client: unknown;
    scheduler: unknown;
  };
};

export interface RuntimeBootstrap {
  initialize(): Promise<RuntimeBootstrapResult>;
}

export class StandaloneJarvisBootstrap implements RuntimeBootstrap {
  constructor(
    private readonly options: {
      config?: JarvisConfig;
      configProvider?: JarvisRuntimeConfigProvider;
      toolRegistry?: RuntimeToolRegistry;
    } = {},
  ) {}

  async initialize(): Promise<RuntimeBootstrapResult> {
    return {
      mode: "standalone",
      config:
        this.options.config ??
        (
          this.options.configProvider ??
          new DefaultJarvisRuntimeConfigProvider()
        ).load(),
      toolRegistry:
        this.options.toolRegistry ?? createDefaultRuntimeToolRegistry(),
    };
  }
}
