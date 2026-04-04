/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WechatChannel } from './wechat.js';
import { ChannelRegistry } from '../channelRegistry.js';

describe('WechatChannel Registration', () => {
  it('should register itself to ChannelRegistry during start', async () => {
    const mockManager = { getAgent: vi.fn() } as any;
    const channel = new WechatChannel(mockManager);
    
    // Mock the session to bypass login
    (channel as any).session = {
      botToken: 'token',
      baseUrl: 'http://api',
      syncBuf: '',
      botId: 'bot1',
      userId: 'user1'
    };

    // We expect this to call ChannelRegistry.getInstance().register()
    // If ChannelRegistry is not imported in wechat.ts, this will throw ReferenceError
    await channel.start();

    expect(ChannelRegistry.getInstance().isRegistered('wechat')).toBe(true);
  });
});
