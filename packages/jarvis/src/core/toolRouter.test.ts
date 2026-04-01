/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../core/src/index.js', () => ({
  recordToolCallInteractions: vi.fn().mockResolvedValue(undefined),
}));

import { ToolRouter } from './toolRouter.js';

describe('ToolRouter', () => {
  const makeReq = (name: string, args: Record<string, unknown> = {}) => ({
    name,
    args,
    callId: `call-${name}`,
  });

  it('routes save_memory to memoryService.saveFact', async () => {
    const saveFact = vi.fn().mockResolvedValue(undefined);
    const search = vi.fn();
    const runSkill = vi.fn();
    const schedule = vi.fn().mockResolvedValue([]);
    const recordCalls = vi.fn();
    const getModel = vi.fn().mockReturnValue('gemini-pro');
    const getChat = vi.fn().mockReturnValue({ getModel, recordCompletedToolCalls: vi.fn() });
    const getCurrentSequenceModel = vi.fn().mockReturnValue(null);
    const config = { api: { apiVersion: 'v1alpha' } };

    const router = new ToolRouter(
      { saveFact, search },
      { runSkill },
      { schedule },
      { getChat, getCurrentSequenceModel, config } as any,
    );

    const onToolResponse = vi.fn();
    const req = makeReq('save_memory', { fact: 'user likes TypeScript' });
    const parts = await router.route([req], new AbortController().signal, onToolResponse);

    expect(saveFact).toHaveBeenCalledWith('preference', 'user likes TypeScript', 10);
    expect(parts).toHaveLength(1);
    expect((parts[0] as any).functionResponse.name).toBe('save_memory');
  });

  it('routes recall_memory to memoryService.search', async () => {
    const saveFact = vi.fn();
    const search = vi.fn().mockResolvedValue(['memory item 1', 'memory item 2']);
    const runSkill = vi.fn();
    const schedule = vi.fn().mockResolvedValue([]);
    const getModel = vi.fn().mockReturnValue('gemini-pro');
    const getChat = vi.fn().mockReturnValue({ getModel, recordCompletedToolCalls: vi.fn() });
    const getCurrentSequenceModel = vi.fn().mockReturnValue(null);
    const config = { api: { apiVersion: 'v1alpha' } };

    const router = new ToolRouter(
      { saveFact, search },
      { runSkill },
      { schedule },
      { getChat, getCurrentSequenceModel, config } as any,
    );

    const onToolResponse = vi.fn();
    const req = makeReq('recall_memory', { query: 'TypeScript', limit: 3 });
    const parts = await router.route([req], new AbortController().signal, onToolResponse);

    expect(search).toHaveBeenCalledWith('TypeScript', 3);
    expect(parts).toHaveLength(1);
    const response = (parts[0] as any).functionResponse.response;
    expect(JSON.stringify(response)).toContain('memory item 1');
  });

  it('routes evolved skills to dynamicRegistry.runSkill', async () => {
    const saveFact = vi.fn();
    const search = vi.fn();
    const runSkill = vi.fn().mockResolvedValue('skill output');
    const schedule = vi.fn().mockResolvedValue([]);
    const getModel = vi.fn().mockReturnValue('gemini-pro');
    const getChat = vi.fn().mockReturnValue({ getModel, recordCompletedToolCalls: vi.fn() });
    const getCurrentSequenceModel = vi.fn().mockReturnValue(null);
    const config = { api: { apiVersion: 'v1alpha' } };

    const router = new ToolRouter(
      { saveFact, search },
      { runSkill },
      { schedule },
      { getChat, getCurrentSequenceModel, config } as any,
    );

    const onToolResponse = vi.fn();
    const req = makeReq('run_evolved_skill_my_skill', { input: 'test' });
    const parts = await router.route([req], new AbortController().signal, onToolResponse);

    expect(runSkill).toHaveBeenCalledWith('run_evolved_skill_my_skill', { input: 'test' });
    expect(parts).toHaveLength(1);
  });

  it('delegates standard tool calls to scheduler', async () => {
    const saveFact = vi.fn();
    const search = vi.fn();
    const runSkill = vi.fn();
    const completedCall = {
      request: { name: 'read_file', callId: 'call-read_file' },
      status: 'success',
      response: { responseParts: [{ text: 'file content' }], resultDisplay: 'file content' },
    };
    const schedule = vi.fn().mockResolvedValue([completedCall]);
    const getModel = vi.fn().mockReturnValue('gemini-pro');
    const recordCompletedToolCalls = vi.fn();
    const getChat = vi.fn().mockReturnValue({ getModel, recordCompletedToolCalls });
    const getCurrentSequenceModel = vi.fn().mockReturnValue(null);
    const config = { api: { apiVersion: 'v1alpha' } };

    const router = new ToolRouter(
      { saveFact, search },
      { runSkill },
      { schedule },
      { getChat, getCurrentSequenceModel, config } as any,
    );

    const onToolResponse = vi.fn();
    const req = makeReq('read_file', { path: '/some/file' });
    const parts = await router.route([req], new AbortController().signal, onToolResponse);

    expect(schedule).toHaveBeenCalledWith([req], expect.any(AbortSignal));
    expect(parts).toHaveLength(1);
    expect(onToolResponse).toHaveBeenCalledWith({
      name: 'read_file',
      status: 'success',
      output: 'file content',
      callId: 'call-read_file',
    });
  });
});
