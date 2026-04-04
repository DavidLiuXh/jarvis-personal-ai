/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { FeishuChannel } from './feishu.js';
import { ChannelRegistry } from '../channelRegistry.js';

describe('FeishuChannel Registration', () => {
  it('should register itself to ChannelRegistry during start', async () => {
    const mockManager = { getAgent: vi.fn() } as any;
    const channel = new FeishuChannel('appId', 'secret', mockManager);
    
    // Mock the WSClient to trigger the start immediately
    (channel as any).wsClient = {
      start: vi.fn().mockImplementation(async ({ eventDispatcher }) => {
        // Registration logic is in start(), let's check it
      })
    };

    await channel.start();

    expect(ChannelRegistry.getInstance().isRegistered('feishu')).toBe(true);
  });
});
