/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type IntentModelClientRequest = {
  system: string;
  prompt: string;
  temperature?: number;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
};

export interface IntentModelClient {
  generateJson(input: IntentModelClientRequest): Promise<string>;
}

export interface EmbeddingClient {
  embed(text: string): Promise<number[]>;
}

export interface VectorStore<T> {
  search(input: {
    query: string;
    topK: number;
    filters?: Record<string, unknown>;
  }): Promise<Array<{ item: T; score: number }>>;
}

export interface Reranker {
  rerank<T>(input: {
    query: string;
    candidates: Array<{ item: T; text: string }>;
  }): Promise<Array<{ item: T; score: number }>>;
}

export interface Clock {
  now(): Date;
}
