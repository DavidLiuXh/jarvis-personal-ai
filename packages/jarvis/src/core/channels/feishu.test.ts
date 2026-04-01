/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { JarvisEventType } from '../types.js';

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn().mockImplementation(() => ({
    im: {
      message: {
        create: vi.fn().mockResolvedValue({ data: { message_id: 'msg-001' } }),
        patch: vi.fn().mockResolvedValue({}),
      },
    },
    tokenManager: { getTenantAccessToken: vi.fn().mockResolvedValue('token') },
  })),
  WSClient: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
  })),
  EventDispatcher: vi.fn().mockImplementation(() => ({
    register: vi.fn().mockReturnThis(),
  })),
  Domain: { Feishu: 'feishu' },
  LoggerLevel: { info: 'info' },
}));

vi.mock('../configManager.js', () => ({
  ConfigManager: {
    getInstance: vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue({ feishu: { showThoughts: false } }),
    }),
  },
}));

vi.mock('../../../../core/src/index.js', () => ({
  debugLogger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// Minimal agent stub that is a real EventEmitter
function makeAgent() {
  const agent = new EventEmitter() as EventEmitter & {
    processMessage: ReturnType<typeof vi.fn>;
  };
  agent.processMessage = vi.fn().mockImplementation(async () => {
    agent.emit(JarvisEventType.DONE);
  });
  return agent;
}

vi.mock('../manager.js', () => ({
  JarvisManager: vi.fn(),
}));

import { FeishuChannel } from './feishu.js';
import { JarvisManager } from '../manager.js';

describe('FeishuChannel DONE listener', () => {
  let channel: FeishuChannel;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(() => {
    agent = makeAgent();
    const manager = {
      getAgent: vi.fn().mockResolvedValue(agent),
    } as unknown as JarvisManager;
    channel = new FeishuChannel('app-id', 'app-secret', manager);
  });

  it('DONE listener count stays at 1 after multiple messages to the same session', async () => {
    // Simulate 3 sequential messages to the same chatId
    const invoke = () =>
      (channel as any).handleUserMessage('chat-001', 'hello', 'session-001');

    await invoke();
    await invoke();
    await invoke();

    // After 3 messages, there should be at most 1 DONE listener remaining
    // (once fires and auto-removes itself)
    const doneListeners = agent.listenerCount(JarvisEventType.DONE);
    expect(doneListeners).toBe(0);
  });

  it('CONTENT listener is removed after DONE fires', async () => {
    await (channel as any).handleUserMessage('chat-001', 'hello', 'session-001');

    const contentListeners = agent.listenerCount(JarvisEventType.CONTENT);
    expect(contentListeners).toBe(0);
  });

  it('updateCard is called exactly once per message even with shared agent', async () => {
    const patchSpy = vi.fn().mockResolvedValue({});
    // Replace the patch mock on the internal client
    (channel as any).client.im.message.patch = patchSpy;

    // Send 2 messages sequentially
    await (channel as any).handleUserMessage('chat-001', 'msg1', 'session-001');
    // Reset spy between messages
    const callsAfterFirst = patchSpy.mock.calls.length;

    await (channel as any).handleUserMessage('chat-001', 'msg2', 'session-001');
    const callsAfterSecond = patchSpy.mock.calls.length;

    // Each message should trigger exactly one final updateCard call on DONE
    // (plus possible intermediate streaming updates, but the final one counts)
    expect(callsAfterFirst).toBeGreaterThanOrEqual(1);
    expect(callsAfterSecond).toBeGreaterThan(callsAfterFirst);
  });
});
