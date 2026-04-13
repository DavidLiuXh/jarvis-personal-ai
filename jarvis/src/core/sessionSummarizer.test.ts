/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  buildIncrementalSummary,
  buildHistoryWithSummary,
  loadSummaryState,
  saveSummaryState,
  getNewOrUpdatedFiles,
  buildStructuredContext,
  mergeStructuredContext,
  renderStructuredContext,
  type SummaryState,
  type SessionMessage,
  type StructuredContext,
} from './sessionSummarizer.js';

// --- helpers ---

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-summary-'));
}

const fakeMessages: SessionMessage[] = [
  { type: 'user', content: 'Hello Jarvis', timestamp: 1000 },
  { type: 'gemini', content: 'Hi! How can I help?', timestamp: 1001 },
  { type: 'user', content: 'I like cycling', timestamp: 1002 },
  { type: 'gemini', content: 'Great hobby!', timestamp: 1003 },
];

// --- tests ---

describe('loadSummaryState / saveSummaryState', () => {
  it('returns null when no summary file exists', () => {
    const dir = tmpDir();
    expect(loadSummaryState(dir)).toBeNull();
  });

  it('round-trips a SummaryState through disk', () => {
    const dir = tmpDir();
    const state: SummaryState = {
      summary: 'User is David, likes cycling.',
      processedFileMtimes: { 'session-a.json': 1000, 'session-b.json': 2000 },
      updatedAt: 12345,
    };
    saveSummaryState(dir, state);
    expect(loadSummaryState(dir)).toEqual(state);
  });
});

describe('buildIncrementalSummary', () => {
  it('generates a new summary when no prior summary exists', async () => {
    const generateText = vi.fn().mockResolvedValue('User likes cycling and is named David.');
    const result = await buildIncrementalSummary(fakeMessages, null, generateText);
    expect(generateText).toHaveBeenCalledOnce();
    expect(result).toBe('User likes cycling and is named David.');
  });

  it('merges existing summary with new messages', async () => {
    const generateText = vi.fn().mockResolvedValue('Updated summary with new info.');
    const existing = 'User is David.';
    const newMessages: SessionMessage[] = [
      { type: 'user', content: 'I also like hiking', timestamp: 2000 },
      { type: 'gemini', content: 'Nice!', timestamp: 2001 },
    ];
    const result = await buildIncrementalSummary(newMessages, existing, generateText);
    expect(generateText).toHaveBeenCalledOnce();
    // Prompt must include existing summary
    const prompt = generateText.mock.calls[0][0] as string;
    expect(prompt).toContain('User is David.');
    expect(prompt).toContain('I also like hiking');
    expect(result).toBe('Updated summary with new info.');
  });

  it('returns existing summary unchanged when no new messages', async () => {
    const generateText = vi.fn();
    const result = await buildIncrementalSummary([], 'Existing summary.', generateText);
    expect(generateText).not.toHaveBeenCalled();
    expect(result).toBe('Existing summary.');
  });

  it('prompt asks for structured compression by topic/time, not fact extraction', async () => {
    const generateText = vi.fn().mockResolvedValue('## Topic\n- item');
    await buildIncrementalSummary(fakeMessages, null, generateText);
    const prompt = generateText.mock.calls[0][0] as string;
    // Must ask for compression/structure, not extraction
    expect(prompt.toLowerCase()).toMatch(/compress|structur/);
    // Must ask for topic or time grouping
    expect(prompt.toLowerCase()).toMatch(/topic|theme/);
    // Must NOT ask to "extract facts" (old approach)
    expect(prompt.toLowerCase()).not.toContain('extract facts');
  });

  it('prompt preserves causal relationships and decisions, not just isolated facts', async () => {
    const generateText = vi.fn().mockResolvedValue('## Topic\n- item');
    await buildIncrementalSummary(fakeMessages, null, generateText);
    const prompt = generateText.mock.calls[0][0] as string;
    expect(prompt.toLowerCase()).toMatch(/decision|outcome|result/);
  });

  it('merge prompt uses XML tags to separate existing summary from new conversation', async () => {
    const generateText = vi.fn().mockResolvedValue('Updated.');
    await buildIncrementalSummary(fakeMessages, 'Old summary.', generateText);
    const prompt = generateText.mock.calls[0][0] as string;
    expect(prompt).toContain('<existing_summary>');
    expect(prompt).toContain('</existing_summary>');
    expect(prompt).toContain('<new_conversation>');
    expect(prompt).toContain('</new_conversation>');
  });

  it('merge prompt instructs to overwrite old facts when new info conflicts', async () => {
    const generateText = vi.fn().mockResolvedValue('Updated.');
    await buildIncrementalSummary(fakeMessages, 'Old summary.', generateText);
    const prompt = generateText.mock.calls[0][0] as string;
    // Must have time-priority / conflict resolution rule
    expect(prompt.toLowerCase()).toMatch(/contradict|conflict|overwrite|supersede|newer/);
  });

  it('merge prompt covers Personal, Technical and Strategic domains', async () => {
    const generateText = vi.fn().mockResolvedValue('Updated.');
    await buildIncrementalSummary(fakeMessages, 'Old summary.', generateText);
    const prompt = generateText.mock.calls[0][0] as string;
    expect(prompt.toLowerCase()).toContain('personal');
    expect(prompt.toLowerCase()).toContain('technical');
    expect(prompt.toLowerCase()).toContain('strategic');
  });
});

describe('buildHistoryWithSummary', () => {
  it('prepends summary as a model turn before recent messages', () => {
    const summary = 'User likes cycling.';
    const recent: SessionMessage[] = [
      { type: 'user', content: 'Hello again', timestamp: 3000 },
      { type: 'gemini', content: 'Welcome back!', timestamp: 3001 },
    ];
    const history = buildHistoryWithSummary(summary, recent);

    expect(history[0].role).toBe('user');
    expect((history[0].parts[0] as any).text).toContain('[CONVERSATION HISTORY SUMMARY]');
    expect((history[0].parts[0] as any).text).toContain('User likes cycling.');
    expect(history[1].role).toBe('model');
    expect((history[1].parts[0] as any).text).toContain('compressed history');
  });

  it('appends recent message turns after the summary', () => {
    const history = buildHistoryWithSummary('Summary.', fakeMessages);
    const userTurns = history.filter(h => h.role === 'user');
    const modelTurns = history.filter(h => h.role === 'model');
    // summary user+model pair + 2 user turns from messages + 2 model turns
    expect(userTurns.length).toBeGreaterThanOrEqual(3);
    expect(modelTurns.length).toBeGreaterThanOrEqual(3);
  });

  it('returns only recent turns when summary is empty', () => {
    const history = buildHistoryWithSummary('', fakeMessages);
    // No summary prefix
    expect(history[0].role).toBe('user');
    expect((history[0].parts[0] as any).text).not.toContain('[CONVERSATION SUMMARY]');
  });
});

describe('getNewOrUpdatedFiles', () => {
  it('returns all files when no prior state exists', () => {
    const files = [
      { name: 'session-a.json', mtime: 1000 },
      { name: 'session-b.json', mtime: 2000 },
    ];
    const result = getNewOrUpdatedFiles(files, null);
    expect(result.map(f => f.name)).toEqual(['session-a.json', 'session-b.json']);
  });

  it('returns only files with mtime newer than recorded mtime', () => {
    const files = [
      { name: 'session-a.json', mtime: 1000 },
      { name: 'session-b.json', mtime: 3000 }, // updated since last summary
      { name: 'session-c.json', mtime: 5000 }, // new file
    ];
    const state: SummaryState = {
      summary: 'old summary',
      processedFileMtimes: { 'session-a.json': 1000, 'session-b.json': 2000 },
      updatedAt: 4000,
    };
    const result = getNewOrUpdatedFiles(files, state);
    expect(result.map(f => f.name)).toEqual(['session-b.json', 'session-c.json']);
  });

  it('returns empty array when all files are unchanged', () => {
    const files = [
      { name: 'session-a.json', mtime: 1000 },
      { name: 'session-b.json', mtime: 2000 },
    ];
    const state: SummaryState = {
      summary: 'summary',
      processedFileMtimes: { 'session-a.json': 1000, 'session-b.json': 2000 },
      updatedAt: 3000,
    };
    const result = getNewOrUpdatedFiles(files, state);
    expect(result).toHaveLength(0);
  });
});

describe('buildIncrementalSummary retry', () => {
  it('retries on transient network error and succeeds on 2nd attempt', async () => {
    const generateText = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce('Summary after retry.');

    const result = await buildIncrementalSummary(fakeMessages, null, generateText, { maxRetries: 3, retryDelayMs: 0 });

    expect(generateText).toHaveBeenCalledTimes(2);
    expect(result).toBe('Summary after retry.');
  });

  it('returns existing summary when all retries fail', async () => {
    const generateText = vi.fn().mockRejectedValue(new Error('socket hang up'));

    const result = await buildIncrementalSummary(fakeMessages, 'Old summary.', generateText, { maxRetries: 2, retryDelayMs: 0 });

    expect(generateText).toHaveBeenCalledTimes(2);
    expect(result).toBe('Old summary.'); // fallback to existing
  });

  it('returns empty string when all retries fail and no existing summary', async () => {
    const generateText = vi.fn().mockRejectedValue(new Error('socket hang up'));

    const result = await buildIncrementalSummary(fakeMessages, null, generateText, { maxRetries: 2, retryDelayMs: 0 });

    expect(result).toBe('');
  });
});

describe('buildStructuredContext', () => {
  it('extracts structured JSON from conversation via LLM', async () => {
    const ctx: StructuredContext = {
      entities: [{ type: 'person', name: 'David', attrs: { profession: 'software engineer' } }],
      behaviors: [{ content: 'runs 3 times a week', confidence: 'high' }],
      decisions: [],
      preferences: [{ content: 'prefers concise answers' }],
      projects: [],
    };
    const generateText = vi.fn().mockResolvedValue(JSON.stringify(ctx));

    const result = await buildStructuredContext(fakeMessages, null, generateText);

    expect(generateText).toHaveBeenCalledOnce();
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].name).toBe('David');
    expect(result.behaviors[0].content).toBe('runs 3 times a week');
  });

  it('returns existing context unchanged when no new messages', async () => {
    const existing: StructuredContext = {
      entities: [{ type: 'person', name: 'David', attrs: {} }],
      behaviors: [], decisions: [], preferences: [], projects: [],
    };
    const generateText = vi.fn();

    const result = await buildStructuredContext([], existing, generateText);

    expect(generateText).not.toHaveBeenCalled();
    expect(result).toEqual(existing);
  });

  it('falls back to empty context when LLM returns malformed JSON', async () => {
    const generateText = vi.fn().mockResolvedValue('not valid json');

    const result = await buildStructuredContext(fakeMessages, null, generateText);

    expect(result.entities).toEqual([]);
  });
});

describe('mergeStructuredContext', () => {
  it('merges new entities into existing context without duplicates', () => {
    const existing: StructuredContext = {
      entities: [{ type: 'person', name: 'David', attrs: { profession: 'engineer' } }],
      behaviors: [{ content: 'runs 3 times a week', confidence: 'high' }],
      decisions: [], preferences: [], projects: [],
    };
    const incoming: StructuredContext = {
      entities: [{ type: 'person', name: 'David', attrs: { hobby: 'cycling' } }],
      behaviors: [{ content: 'reads books regularly', confidence: 'medium' }],
      decisions: [{ topic: 'investment', content: 'core-satellite strategy', date: '2026-03' }],
      preferences: [], projects: [],
    };

    const merged = mergeStructuredContext(existing, incoming);

    // David should be merged, not duplicated
    expect(merged.entities.filter(e => e.name === 'David')).toHaveLength(1);
    // New behavior added
    expect(merged.behaviors.some(b => b.content.includes('reads books'))).toBe(true);
    // Decision added
    expect(merged.decisions).toHaveLength(1);
  });
});

describe('renderStructuredContext', () => {
  it('renders structured context as compact text block', () => {
    const ctx: StructuredContext = {
      entities: [{ type: 'person', name: 'David', attrs: { profession: 'software engineer' } }],
      behaviors: [{ content: 'runs 3 times a week', confidence: 'high' }],
      decisions: [{ topic: 'investment', content: 'core-satellite strategy', date: '2026-03' }],
      preferences: [{ content: 'prefers concise answers in Chinese' }],
      projects: [{ name: 'Jarvis', status: 'active', key_rules: ['do not modify gemini-cli source'] }],
    };

    const text = renderStructuredContext(ctx);

    expect(text).toContain('David');
    expect(text).toContain('software engineer');
    expect(text).toContain('runs 3 times a week');
    expect(text).toContain('core-satellite strategy');
    expect(text).toContain('prefers concise answers in Chinese');
    expect(text).toContain('Jarvis');
    expect(text).toContain('do not modify gemini-cli source');
  });

  it('returns empty string for empty context', () => {
    const ctx: StructuredContext = {
      entities: [], behaviors: [], decisions: [], preferences: [], projects: [],
    };
    expect(renderStructuredContext(ctx)).toBe('');
  });
});

describe('buildStructuredContext prompt quality', () => {
  it('prompt restricts entities to user and Jarvis only', async () => {
    const generateText = vi.fn().mockResolvedValue('{"entities":[],"behaviors":[],"decisions":[],"preferences":[],"projects":[]}');
    await buildStructuredContext(fakeMessages, null, generateText);
    const prompt = generateText.mock.calls[0][0] as string;
    // Must restrict entities to person (user) only — not tools/systems/companies
    expect(prompt).toContain('ONLY the user');
    expect(prompt.toLowerCase()).toContain('do not add');
  });

  it('prompt requires user person entity to have attrs like profession and skills', async () => {
    const generateText = vi.fn().mockResolvedValue('{"entities":[],"behaviors":[],"decisions":[],"preferences":[],"projects":[]}');
    await buildStructuredContext(fakeMessages, null, generateText);
    const prompt = generateText.mock.calls[0][0] as string;
    expect(prompt).toContain('profession');
    expect(prompt).toContain('skills');
  });

  it('prompt requires decisions to capture important choices like strategies and rules', async () => {
    const generateText = vi.fn().mockResolvedValue('{"entities":[],"behaviors":[],"decisions":[],"preferences":[],"projects":[]}');
    await buildStructuredContext(fakeMessages, null, generateText);
    const prompt = generateText.mock.calls[0][0] as string;
    expect(prompt).toContain('strateg');
    expect(prompt).toContain('rule');
  });

  it('prompt restricts preferences to Jarvis response style only', async () => {
    const generateText = vi.fn().mockResolvedValue('{"entities":[],"behaviors":[],"decisions":[],"preferences":[],"projects":[]}');
    await buildStructuredContext(fakeMessages, null, generateText);
    const prompt = generateText.mock.calls[0][0] as string;
    expect(prompt.toLowerCase()).toContain('style');
    expect(prompt).toContain('format');
  });
});

describe('buildStructuredContext degradation', () => {
  it('returns existing context when LLM fails all retries', async () => {
    const existing: StructuredContext = {
      entities: [{ type: 'person', name: 'David', attrs: { profession: 'engineer' } }],
      behaviors: [{ content: 'user runs 3 times a week', confidence: 'high' }],
      decisions: [], preferences: [], projects: [],
    };
    const generateText = vi.fn().mockRejectedValue(new Error('network error'));

    const result = await buildStructuredContext(fakeMessages, existing, generateText, { maxRetries: 2, retryDelayMs: 0 });

    // Must return existing context, not empty
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].name).toBe('David');
    expect(result.behaviors).toHaveLength(1);
  });

  it('returns empty context (not throws) when no existing and LLM fails', async () => {
    const generateText = vi.fn().mockRejectedValue(new Error('network error'));

    const result = await buildStructuredContext(fakeMessages, null, generateText, { maxRetries: 2, retryDelayMs: 0 });

    // Must not throw, must return empty (not null/undefined)
    expect(result).toBeDefined();
    expect(result.entities).toEqual([]);
  });
});

describe('structured context prompt quality — behaviors and projects', () => {
  it('prompt requires behaviors to be recurring/habitual, not one-time events', async () => {
    const generateText = vi.fn().mockResolvedValue('{"entities":[],"behaviors":[],"decisions":[],"preferences":[],"projects":[]}');
    await buildStructuredContext(fakeMessages, null, generateText);
    const prompt = generateText.mock.calls[0][0] as string;
    expect(prompt.toLowerCase()).toContain('recurring');
    expect(prompt.toLowerCase()).toContain('one-time');
  });

  it('prompt requires behaviors to include frequency or regularity', async () => {
    const generateText = vi.fn().mockResolvedValue('{"entities":[],"behaviors":[],"decisions":[],"preferences":[],"projects":[]}');
    await buildStructuredContext(fakeMessages, null, generateText);
    const prompt = generateText.mock.calls[0][0] as string;
    expect(prompt.toLowerCase()).toContain('frequenc');
  });

  it('prompt excludes upstream dependencies from projects', async () => {
    const generateText = vi.fn().mockResolvedValue('{"entities":[],"behaviors":[],"decisions":[],"preferences":[],"projects":[]}');
    await buildStructuredContext(fakeMessages, null, generateText);
    const prompt = generateText.mock.calls[0][0] as string;
    expect(prompt.toLowerCase()).toContain('upstream');
    expect(prompt.toLowerCase()).toContain('dependenc');
  });
});
