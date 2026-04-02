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
  type SummaryState,
  type SessionMessage,
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
      processedFiles: ['session-a.json', 'session-b.json'],
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
    expect((history[0].parts[0] as any).text).toContain('[CONVERSATION SUMMARY]');
    expect((history[0].parts[0] as any).text).toContain('User likes cycling.');
    expect(history[1].role).toBe('model');
    expect((history[1].parts[0] as any).text).toContain('summary noted');
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
