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
  const service = new (MemoryService as new (root: string, dbPath?: string) => InstanceType<typeof MemoryService>)('', tmpDir);

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

  it('consolidation prompt includes category definitions and dedup rules', async () => {
    const generateText = vi.fn().mockResolvedValue('[]');
    const { service } = await createService(vi.fn());
    service.setGenerateText(generateText);

    const svc = service as unknown as Record<string, unknown>;
    const db = svc.db as { prepare: (sql: string) => { run: (...args: unknown[]) => void } };
    for (let i = 0; i < 6; i++) {
      db.prepare('INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)')
        .run('behavior', `fact-${i}`, 5, Date.now());
    }
    svc.lastConsolidatedCount = 0;

    await service.consolidateFacts();

    const prompt = generateText.mock.calls[0][0] as string;
    expect(prompt).toContain('mutually exclusive');
    expect(prompt).toContain('behavior');
    expect(prompt).toContain('preference');
    expect(prompt).toContain('identity');
    expect(prompt).toContain('specification');
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

describe('MemoryService.saveFact semantic dedup', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function createDedupeService(dedupStrategy?: 'jaccard' | 'embedding') {
    vi.doMock('./configManager.js', () => ({
      ConfigManager: {
        getInstance: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({
            api: { key: 'test-key', proxy: null },
            models: {
              embedding: 'test-embedding-model',
              embeddingDimension: 128,
              distillation: 'test-distillation-model',
            },
            memory: {
              ingestionDelayMs: 0,
              retrievalLimit: 5,
              consolidationThreshold: 100, // high threshold to avoid triggering consolidation
              dedupStrategy: dedupStrategy ?? 'jaccard',
            },
          }),
        }),
      },
    }));
    const { MemoryService } = await import('./memory.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-dedup-'));
    const service = new (MemoryService as new (root: string, dbPath?: string) => InstanceType<typeof MemoryService>)('', tmpDir);
    return { service, tmpDir };
  }

  it('skips saving a fact when a textually similar Latin fact already exists', async () => {
    const { service } = await createDedupeService();

    await service.saveFact('behavior', 'user runs 3 times a week', 8);

    const db = (service as unknown as Record<string, unknown>).db as any;
    expect((db.prepare('SELECT count(*) as c FROM facts').get() as any).c).toBe(1);

    await service.saveFact('behavior', 'runs at least 3 times per week', 8);

    expect((db.prepare('SELECT count(*) as c FROM facts').get() as any).c).toBe(1);
  });

  it('skips saving a fact when a textually similar CJK fact already exists', async () => {
    const { service } = await createDedupeService();

    await service.saveFact('behavior', '每周跑步三次', 8);

    const db = (service as unknown as Record<string, unknown>).db as any;
    expect((db.prepare('SELECT count(*) as c FROM facts').get() as any).c).toBe(1);

    // Similar CJK content — should be skipped via lower CJK threshold
    await service.saveFact('behavior', '每周至少跑步3次', 8);

    expect((db.prepare('SELECT count(*) as c FROM facts').get() as any).c).toBe(1);
  });

  it('does not falsely deduplicate unrelated CJK facts', async () => {
    const { service } = await createDedupeService();

    await service.saveFact('behavior', '我对历史很感兴趣', 8);
    await service.saveFact('behavior', '我每周跑步三次', 8);

    const db = (service as unknown as Record<string, unknown>).db as any;
    expect((db.prepare('SELECT count(*) as c FROM facts').get() as any).c).toBe(2);
  });

  it('saves a fact when it is semantically different from existing facts', async () => {
    const { service } = await createDedupeService();

    await service.saveFact('behavior', 'user runs 3 times a week', 8);
    await service.saveFact('behavior', 'user codes every day', 8);

    const db = (service as unknown as Record<string, unknown>).db as any;
    const count = (db.prepare('SELECT count(*) as c FROM facts').get() as any).c;
    expect(count).toBe(2);
  });

  it('logs a message when a duplicate is skipped', async () => {
    const { service } = await createDedupeService();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await service.saveFact('behavior', 'user runs 3 times a week', 8);
    await service.saveFact('behavior', 'runs at least 3 times per week', 8);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Duplicate skipped'),
    );
    consoleSpy.mockRestore();
  });

  it('uses embedding strategy when dedupStrategy is embedding and embedContentFn is injected', async () => {
    const { service } = await createDedupeService('embedding');

    // Two nearly-identical vectors (cosine sim ≈ 1.0)
    const vec1 = new Array(128).fill(0); vec1[0] = 1.0;
    const vec2 = new Array(128).fill(0); vec2[0] = 0.9999;

    let callCount = 0;
    service.setEmbedContent(async (_text: string) => {
      return callCount++ === 0 ? vec1 : vec2;
    });

    await service.saveFact('behavior', 'user runs 3 times a week', 8);
    await service.saveFact('behavior', '每周跑步三次', 8); // different text, similar vector

    const db = (service as unknown as Record<string, unknown>).db as any;
    const count = (db.prepare('SELECT count(*) as c FROM facts').get() as any).c;
    expect(count).toBe(1); // duplicate rejected via embedding similarity
  });

  it('falls back to jaccard when embedding strategy fails', async () => {
    const { service } = await createDedupeService('embedding');

    service.setEmbedContent(async (_text: string) => {
      throw new Error('embedding API unavailable');
    });

    await service.saveFact('behavior', 'user runs 3 times a week', 8);
    await service.saveFact('behavior', 'runs at least 3 times per week', 8); // similar via jaccard

    const db = (service as unknown as Record<string, unknown>).db as any;
    const count = (db.prepare('SELECT count(*) as c FROM facts').get() as any).c;
    expect(count).toBe(1); // still deduped via jaccard fallback
  });
});

describe('MemoryService.searchFacts', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function createServiceWithFacts(facts: Array<{ category: string; content: string; importance: number }>) {
    vi.doMock('./configManager.js', () => ({
      ConfigManager: {
        getInstance: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({
            api: { key: 'test-key', proxy: null },
            models: { embedding: 'test-model', embeddingDimension: 4, distillation: 'test-model' },
            memory: { ingestionDelayMs: 0, retrievalLimit: 5, consolidationThreshold: 100, dedupStrategy: 'jaccard', factRelevanceStrategy: 'jaccard', factRelevanceLimit: 3 },
          }),
        }),
      },
    }));
    const { MemoryService } = await import('./memory.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-search-'));
    const service = new (MemoryService as new (root: string, dbPath?: string) => InstanceType<typeof MemoryService>)('', tmpDir);
    // Insert facts directly into DB
    const db = (service as unknown as Record<string, unknown>).db as any;
    for (const f of facts) {
      db.prepare('INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)').run(f.category, f.content, f.importance, Date.now());
    }
    return { service };
  }

  it('jaccard: returns facts ranked by relevance to query, up to limit', async () => {
    const { service } = await createServiceWithFacts([
      { category: 'identity', content: 'user is a software engineer', importance: 8 },
      { category: 'identity', content: 'user likes history', importance: 7 },
      { category: 'behavior', content: 'user runs 3 times a week', importance: 6 },
      { category: 'specification', content: 'project uses TypeScript', importance: 9 },
      { category: 'specification', content: 'do not modify gemini-cli source', importance: 9 },
    ]);

    const results = await service.searchFacts('TypeScript project setup', 2);

    // 'project uses TypeScript' should rank highest for this query
    // limit=2 applies to identity/specification candidates only (preference/behavior always included)
    const nonStyleFacts = results.filter(f => f.category !== 'preference' && f.category !== 'behavior');
    expect(nonStyleFacts.length).toBeLessThanOrEqual(2);
    expect(results.some(f => f.content.includes('TypeScript'))).toBe(true);
  });

  it('always includes preference and behavior facts regardless of relevance', async () => {
    const { service } = await createServiceWithFacts([
      { category: 'identity', content: 'user is a software engineer', importance: 8 },
      { category: 'preference', content: 'prefers concise answers', importance: 10 },
      { category: 'behavior', content: 'user runs 3 times a week', importance: 6 },
      { category: 'specification', content: 'project uses TypeScript', importance: 9 },
    ]);

    // Query is about cooking — unrelated to all facts
    const results = await service.searchFacts('cooking recipes', 1);

    // preference and behavior must always be included
    expect(results.some(f => f.category === 'preference')).toBe(true);
    expect(results.some(f => f.category === 'behavior')).toBe(true);
  });

  it('embedding: uses embedContentFn to rank facts by cosine similarity', async () => {
    vi.doMock('./configManager.js', () => ({
      ConfigManager: {
        getInstance: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({
            api: { key: 'test-key', proxy: null },
            models: { embedding: 'test-model', embeddingDimension: 4, distillation: 'test-model' },
            memory: { ingestionDelayMs: 0, retrievalLimit: 5, consolidationThreshold: 100, dedupStrategy: 'jaccard', factRelevanceStrategy: 'embedding', factRelevanceLimit: 2 },
          }),
        }),
      },
    }));
    const { MemoryService } = await import('./memory.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-embed-search-'));
    const service = new (MemoryService as new (root: string, dbPath?: string) => InstanceType<typeof MemoryService>)('', tmpDir);

    const db = (service as unknown as Record<string, unknown>).db as any;
    // Insert facts with known embeddings
    const tsVec = new Float32Array([1, 0, 0, 0]);
    const runVec = new Float32Array([0, 1, 0, 0]);
    const histVec = new Float32Array([0, 0, 1, 0]);
    const prefVec = new Float32Array([0, 0, 0, 1]);

    const insertFact = (cat: string, content: string, imp: number, vec: Float32Array) => {
      const info = db.prepare('INSERT INTO facts (category, content, importance, timestamp, embedding) VALUES (?, ?, ?, ?, ?)').run(cat, content, imp, Date.now(), Buffer.from(vec.buffer));
      return info.lastInsertRowid;
    };
    insertFact('specification', 'project uses TypeScript', 9, tsVec);
    insertFact('behavior', 'user runs 3 times a week', 6, runVec);
    insertFact('identity', 'user likes history', 7, histVec);
    insertFact('preference', 'prefers concise answers', 10, prefVec);

    // Query vector close to TypeScript vector
    service.setEmbedContent(async (_text: string) => [1, 0, 0, 0]);

    const results = await service.searchFacts('TypeScript setup', 1);

    // TypeScript fact should be top result; preference/behavior always included
    expect(results.some(f => f.content.includes('TypeScript'))).toBe(true);
    expect(results.some(f => f.category === 'preference')).toBe(true);
    expect(results.some(f => f.category === 'behavior')).toBe(true);
  });
});
