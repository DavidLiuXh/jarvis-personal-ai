/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  MemoryContract,
  MemoryInjectionResult,
  MemoryRetrievalResult,
  MemoryRuntimeEvent,
  TokenBudget,
  UserTurnInput,
} from "./types.js";

export interface MemoryRuntime<TIntent = unknown> {
  understand(input: UserTurnInput): Promise<TIntent>;

  planMemory(input: {
    prompt: string;
    history: UserTurnInput["history"];
    intent: TIntent;
  }): Promise<MemoryContract>;

  retrieve(contract: MemoryContract): Promise<MemoryRetrievalResult>;

  inject(input: {
    prompt: string;
    intent: TIntent;
    contract: MemoryContract;
    retrieval: MemoryRetrievalResult;
    budget: TokenBudget;
  }): Promise<MemoryInjectionResult>;

  observe(event: MemoryRuntimeEvent): Promise<void>;
}

export type MemoryRuntimeUnderstand<TIntent> = (
  input: UserTurnInput,
) => Promise<TIntent>;

export type MemoryRuntimePlanMemory<TIntent> = (input: {
  prompt: string;
  history: UserTurnInput["history"];
  intent: TIntent;
}) => Promise<MemoryContract>;

export type MemoryRuntimeRetrieve = (
  contract: MemoryContract,
) => Promise<MemoryRetrievalResult>;

export type MemoryRuntimeInject<TIntent> = (input: {
  prompt: string;
  intent: TIntent;
  contract: MemoryContract;
  retrieval: MemoryRetrievalResult;
  budget: TokenBudget;
}) => Promise<MemoryInjectionResult>;

export type MemoryRuntimeObserve = (
  event: MemoryRuntimeEvent,
) => Promise<void> | void;

export type DefaultMemoryRuntimeOptions<TIntent> = {
  understand: MemoryRuntimeUnderstand<TIntent>;
  planMemory: MemoryRuntimePlanMemory<TIntent>;
  retrieve: MemoryRuntimeRetrieve;
  inject: MemoryRuntimeInject<TIntent>;
  observe?: MemoryRuntimeObserve;
};

export class DefaultMemoryRuntime<TIntent = unknown>
  implements MemoryRuntime<TIntent>
{
  constructor(private readonly options: DefaultMemoryRuntimeOptions<TIntent>) {}

  async understand(input: UserTurnInput): Promise<TIntent> {
    const intent = await this.options.understand(input);
    await this.observe({
      type: "intent_resolved",
      sessionId: input.sessionId,
      prompt: input.prompt,
      observed: intent,
    });
    return intent;
  }

  async planMemory(input: {
    prompt: string;
    history: UserTurnInput["history"];
    intent: TIntent;
  }): Promise<MemoryContract> {
    return this.options.planMemory(input);
  }

  async retrieve(contract: MemoryContract): Promise<MemoryRetrievalResult> {
    const result = await this.options.retrieve(contract);
    await this.observe({
      type: "memory_retrieved",
      sessionId: result.session[0]?.item.sessionId ?? "unknown",
      contract,
      result,
    });
    return result;
  }

  async inject(input: {
    prompt: string;
    intent: TIntent;
    contract: MemoryContract;
    retrieval: MemoryRetrievalResult;
    budget: TokenBudget;
  }): Promise<MemoryInjectionResult> {
    const result = await this.options.inject(input);
    await this.observe({
      type: "memory_injected",
      sessionId: input.retrieval.session[0]?.item.sessionId ?? "unknown",
      contract: input.contract,
      result,
    });
    return result;
  }

  async observe(event: MemoryRuntimeEvent): Promise<void> {
    await this.options.observe?.(event);
  }
}
