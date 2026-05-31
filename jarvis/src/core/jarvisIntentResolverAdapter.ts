/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type IntentResolverAdapter,
  type IntentResolverAdapterInput,
  type IntentResolverAdapterResult,
} from "../intent-runtime/index.js";
import {
  IntentResolver,
  type IntentResolverOptions,
} from "./intentResolver.js";

export type JarvisIntentResolverAdapterOptions = IntentResolverOptions;

export class JarvisIntentResolverAdapter implements IntentResolverAdapter {
  constructor(private readonly options: JarvisIntentResolverAdapterOptions) {}

  async resolve(
    input: IntentResolverAdapterInput,
  ): Promise<IntentResolverAdapterResult> {
    const resolver = new IntentResolver(this.options);
    const intent = await resolver.resolve({
      userPrompt: input.userPrompt,
      history: input.history,
      now: input.now,
    });
    return {
      intent,
      source: this.options.modelSource ?? intent.source,
      diagnostics: {
        model: this.options.model,
        historyTurns: this.options.historyTurns,
      },
    };
  }
}
