/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { buildHistoryFromMessages } from './resumeFromDisk.js';

describe('buildHistoryFromMessages', () => {
  it('includes model text turn for gemini message with content', () => {
    const history = buildHistoryFromMessages([
      { type: 'user', content: [{ text: 'Hello Jarvis' }] },
      { type: 'gemini', content: 'Hi there! How can I help?' },
    ]);

    const modelTurn = history.find(h => h.role === 'model');
    expect(modelTurn).toBeDefined();
    expect((modelTurn!.parts[0] as any).text).toContain('Hi there');
  });

  it('includes functionResponse turn for gemini message with toolCalls', () => {
    const history = buildHistoryFromMessages([
      { type: 'user', content: [{ text: 'What time is it?' }] },
      {
        type: 'gemini',
        content: '',
        toolCalls: [{ name: 'run_shell_command', result: { output: '10:00 AM' } }],
      },
    ]);

    const funcRespTurn = history.find(
      h => h.role === 'user' && (h.parts[0] as any)?.functionResponse,
    );
    expect(funcRespTurn).toBeDefined();
    expect((funcRespTurn!.parts[0] as any).functionResponse.name).toBe('run_shell_command');
  });

  it('includes both model text and functionResponse when gemini message has both', () => {
    const history = buildHistoryFromMessages([
      { type: 'user', content: [{ text: 'Run a command' }] },
      {
        type: 'gemini',
        content: 'Sure, running it now.',
        toolCalls: [{ name: 'run_shell_command', result: { output: 'done' } }],
      },
    ]);

    const modelTurn = history.find(h => h.role === 'model');
    const funcRespTurn = history.find(
      h => h.role === 'user' && (h.parts[0] as any)?.functionResponse,
    );
    expect(modelTurn).toBeDefined();
    expect(funcRespTurn).toBeDefined();
  });

  it('skips gemini messages with empty content and no toolCalls', () => {
    const history = buildHistoryFromMessages([
      { type: 'user', content: [{ text: 'Hello' }] },
      { type: 'gemini', content: '' },
    ]);

    const modelTurn = history.find(h => h.role === 'model');
    expect(modelTurn).toBeUndefined();
  });

  it('preserves correct ordering: user → model → functionResponse', () => {
    const history = buildHistoryFromMessages([
      { type: 'user', content: [{ text: 'Run a command' }] },
      {
        type: 'gemini',
        content: 'Running now.',
        toolCalls: [{ name: 'run_shell_command', result: { output: 'done' } }],
      },
      { type: 'user', content: [{ text: 'Thanks' }] },
      { type: 'gemini', content: 'You are welcome.' },
    ]);

    expect(history[0].role).toBe('user');
    expect(history[1].role).toBe('model');
    expect(history[2].role).toBe('user'); // functionResponse
    expect(history[3].role).toBe('user'); // next user message
    expect(history[4].role).toBe('model');
  });
});
