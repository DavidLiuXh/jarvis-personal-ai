/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  IntentResolver as RuntimeIntentResolver,
  type IntentResolverOptions,
} from "../../../packages/intent-runtime/src/intentResolver.js";
import { JarvisOllamaIntentModelClient } from "./jarvisOllamaIntentModelClient.js";

export * from "../../../packages/intent-runtime/src/intentResolver.js";

export class IntentResolver extends RuntimeIntentResolver {
  constructor(options: IntentResolverOptions) {
    if (options.modelClient || !options.model) {
      super(options);
      return;
    }

    super({
      ...options,
      modelSource: options.modelSource ?? "local-intent/ollama",
      modelClient: new JarvisOllamaIntentModelClient({
        model: options.model,
        baseUrl: options.baseUrl,
        timeoutMs: options.timeoutMs,
      }),
    });
  }
}
