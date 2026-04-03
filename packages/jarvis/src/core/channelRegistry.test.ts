/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { ChannelRegistry } from './channelRegistry.js';

describe('ChannelRegistry', () => {
  it('registers a channel and pushes a message to it', async () => {
    const push = vi.fn().mockResolvedValue(undefined);
    const registry = new ChannelRegistry();
    registry.register('feishu', { push });

    await registry.push('feishu', 'oc_test', 'Hello from Jarvis');

    expect(push).toHaveBeenCalledWith('oc_test', 'Hello from Jarvis');
  });

  it('throws when pushing to an unregistered channel', async () => {
    const registry = new ChannelRegistry();
    await expect(registry.push('unknown', 'oc_test', 'msg')).rejects.toThrow(
      /channel.*not registered/i,
    );
  });

  it('pushes to default channel when no channel specified', async () => {
    const push = vi.fn().mockResolvedValue(undefined);
    const registry = new ChannelRegistry('feishu');
    registry.register('feishu', { push });

    await registry.pushDefault('oc_test', 'Hello');

    expect(push).toHaveBeenCalledWith('oc_test', 'Hello');
  });

  it('throws when pushDefault called with no default channel set', async () => {
    const registry = new ChannelRegistry();
    await expect(registry.pushDefault('oc_test', 'msg')).rejects.toThrow(
      /no default channel/i,
    );
  });

  it('isRegistered returns true only for registered channels', () => {
    const registry = new ChannelRegistry();
    registry.register('feishu', { push: vi.fn() });
    expect(registry.isRegistered('feishu')).toBe(true);
    expect(registry.isRegistered('wechat')).toBe(false);
  });
});
