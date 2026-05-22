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
