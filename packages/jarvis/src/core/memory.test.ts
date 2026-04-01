/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// --- Mocks ---

vi.mock('sqlite-vec', () => ({
  load: vi.fn(),
}));

vi.mock('../../../core/src/index.js', () => ({
  debugLogger: { debug: vi.fn(), error: vi.fn() },
}));

vi.mock('./configManager.js', () => ({
  ConfigManager: {
    getInstance: () => ({
      get: () => ({
        api: { key: 'test-key', proxy: null },
        models: {
          embedding: 'test-embedding-model',
          embeddingDimension: 128,
          distillation: 'test-distillation-model',
        },
        memory: {
          ingestionDelayMs: 0,
          retrievalLimit: 5,
          consolidationThreshold: 3,
        },
      }),
    }),
  },
}));

// --- Helpers ---

/**
 * Creates an in-memory MemoryService with a fake LLM client injected.
 * Returns the service instance and a handle to the fake client.
 */
async function createService(fakeGenerateContent: () => Promise<unknown>) {
  // Dynamically import AFTER mocks are set up
  const { MemoryService } = await import('./memory.js');

  // Use a temp dir so the real DB file isn't created in ~/.gemini-jarvis
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-test-'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new (MemoryService as new (root: string) => InstanceType<typeof MemoryService>)(tmpDir);

  // Inject a fake AI client directly (bypasses API key / network)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (service as unknown as Record<string, unknown>).client = {
    models: {
      generateContent: fakeGenerateContent,
      embedContent: vi.fn().mockResolvedValue({
        embeddings: [{ values: new Array(128).fill(0) }],
      }),
    },
  };

  return { service, tmpDir };
}

// --- Tests ---

describe('MemoryService.consolidateFacts', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('does not re-trigger consolidation when LLM returns invalid JSON', async () => {
    // LLM returns garbage — no valid JSON array
    const generateContent = vi.fn().mockResolvedValue({
      response: {
        candidates: [{ content: { parts: [{ text: 'sorry, I cannot help with that' }] } }],
      },
    });

    const { service } = await createService(generateContent);

    // Seed enough facts to cross the consolidation threshold (default: 3)
    const svc1 = service as unknown as Record<string, unknown>;
    const db1 = svc1.db as { prepare: (sql: string) => { run: (...args: unknown[]) => void } };
    for (let i = 0; i < 6; i++) {
      db1
        .prepare('INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)')
        .run('test', `fact-${i}`, 5, Date.now());
    }
    svc1.lastConsolidatedCount = 0;

    // First consolidation attempt — LLM returns invalid JSON
    await service.consolidateFacts();

    const callsAfterFirst = generateContent.mock.calls.length;
    expect(callsAfterFirst).toBe(1);

    // Save one more fact — should NOT trigger another consolidation
    // because lastConsolidatedCount should have been updated after the failed attempt
    await service.saveFact('test', 'one-more-fact', 5);

    expect(generateContent.mock.calls.length).toBe(1); // still 1, no second call
  });

  it('uses injected generateText instead of this.client when available', async () => {
    const consolidatedFacts = [
      { category: 'behavior', content: 'user runs 3 times a week', importance: 7 },
    ];

    // this.client.generateContent should NOT be called
    const legacyGenerateContent = vi.fn();
    const { service } = await createService(legacyGenerateContent);

    // Inject the CLI-auth generateText function
    const generateText = vi.fn().mockResolvedValue(JSON.stringify(consolidatedFacts));
    service.setGenerateText(generateText);

    const svc = service as unknown as Record<string, unknown>;
    const db = svc.db as { prepare: (sql: string) => { run: (...args: unknown[]) => void } };
    for (let i = 0; i < 6; i++) {
      db.prepare('INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)')
        .run('test', `fact-${i}`, 5, Date.now());
    }
    svc.lastConsolidatedCount = 0;

    await service.consolidateFacts();

    expect(generateText).toHaveBeenCalledOnce();
    expect(legacyGenerateContent).not.toHaveBeenCalled();
    expect((service as unknown as Record<string, unknown>).lastConsolidatedCount).toBe(1);
  });

  it('updates lastConsolidatedCount after successful consolidation', async () => {
    const consolidatedFacts = [
      { category: 'test', content: 'merged-fact-1', importance: 8 },
      { category: 'test', content: 'merged-fact-2', importance: 7 },
    ];

    const generateContent = vi.fn().mockResolvedValue({
      response: {
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify(consolidatedFacts) }],
            },
          },
        ],
      },
    });

    const { service } = await createService(generateContent);

    const svc2 = service as unknown as Record<string, unknown>;
    const db2 = svc2.db as { prepare: (sql: string) => { run: (...args: unknown[]) => void } };
    for (let i = 0; i < 6; i++) {
      db2
        .prepare('INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)')
        .run('test', `fact-${i}`, 5, Date.now());
    }
    svc2.lastConsolidatedCount = 0;

    await service.consolidateFacts();

    // After success, lastConsolidatedCount should equal the number of consolidated facts
    expect((service as unknown as Record<string, unknown>).lastConsolidatedCount).toBe(consolidatedFacts.length);
  });
});
