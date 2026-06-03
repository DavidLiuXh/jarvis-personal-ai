/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { JarvisConfig } from "./configManager.js";
import { ConfigManager } from "./configManager.js";

export type RuntimeSecretProvider = {
  get(name: string): string | undefined;
};

export class EnvRuntimeSecretProvider implements RuntimeSecretProvider {
  get(name: string): string | undefined {
    return process.env[name];
  }
}

export type JarvisRuntimeConfigProvider = {
  load(): JarvisConfig;
  secrets: RuntimeSecretProvider;
};

export class DefaultJarvisRuntimeConfigProvider
  implements JarvisRuntimeConfigProvider
{
  readonly secrets: RuntimeSecretProvider;

  constructor(
    private readonly options: {
      config?: JarvisConfig;
      secrets?: RuntimeSecretProvider;
    } = {},
  ) {
    this.secrets = options.secrets ?? new EnvRuntimeSecretProvider();
  }

  load(): JarvisConfig {
    return this.options.config ?? ConfigManager.getInstance().get();
  }
}
