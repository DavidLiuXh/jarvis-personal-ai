/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { JarvisEventType } from './types.js';
import { ProactiveTaskRunner } from './proactiveTaskRunner.js';

function makeAgent(responseText: string, shouldError = false) {
  const agent = new EventEmitter() as EventEmitter & {
    processMessage: ReturnType<typeof vi.fn>;
  };
  agent.processMessage = vi.fn().mockImplementation(async () => {
    if (shouldError) {
      agent.emit(JarvisEventType.ERROR, new Error('agent error'));
    } else {
      agent.emit(JarvisEventType.CONTENT, { type: JarvisEventType.CONTENT, value: responseText });
      agent.emit(JarvisEventType.DONE);
    }
  });
  return agent;
}

function makeRegistry(pushSafeResult = true) {
  return { pushSafe: vi.fn().mockResolvedValue(pushSafeResult) } as any;
}

describe('ProactiveTaskRunner', () => {
  it('runs a task and pushes result to the channel via pushSafe', async () => {
    const agent = makeAgent('Market analysis: bullish');
    const getAgent = vi.fn().mockResolvedValue(agent);
    const registry = makeRegistry();

    const runner = new ProactiveTaskRunner(getAgent);
    await runner.run(
      { id: 't1', prompt: 'Analyze market', channel: 'feishu', chatId: 'oc_1', cron: '', enabled: true },
      registry,
    );

    expect(registry.pushSafe).toHaveBeenCalledWith('feishu', 'oc_1', 'Market analysis: bullish');
  });

  it('pushes error message when agent fails', async () => {
    const agent = makeAgent('', true);
    const getAgent = vi.fn().mockResolvedValue(agent);
    const registry = makeRegistry();

    const runner = new ProactiveTaskRunner(getAgent);
    await runner.run(
      { id: 't1', prompt: 'Analyze market', channel: 'feishu', chatId: 'oc_1', cron: '', enabled: true },
      registry,
    );

    expect(registry.pushSafe).toHaveBeenCalledWith('feishu', 'oc_1', expect.stringContaining('❌'));
  });

  it('queues concurrent tasks and runs them sequentially', async () => {
    const order: string[] = [];
    const makeSlowAgent = (id: string, delay: number) => {
      const agent = new EventEmitter() as any;
      agent.processMessage = vi.fn().mockImplementation(async () => {
        await new Promise(r => setTimeout(r, delay));
        order.push(id);
        agent.emit(JarvisEventType.CONTENT, { type: JarvisEventType.CONTENT, value: id });
        agent.emit(JarvisEventType.DONE);
      });
      return agent;
    };

    const agentT1 = makeSlowAgent('t1', 20);
    const agentT2 = makeSlowAgent('t2', 5);
    let callCount = 0;
    const getAgent = vi.fn().mockImplementation(async () => {
      return callCount++ === 0 ? agentT1 : agentT2;
    });

    const runner = new ProactiveTaskRunner(getAgent);
    const task = (id: string) => ({
      id, prompt: id, channel: 'feishu', chatId: 'oc_1', cron: '', enabled: true,
    });

    const p1 = runner.run(task('t1'), makeRegistry());
    const p2 = runner.run(task('t2'), makeRegistry());

    await Promise.all([p1, p2]);

    expect(order).toEqual(['t1', 't2']);
  });

  it('skips push when task has no channel', async () => {
    const agent = makeAgent('Result without push');
    const getAgent = vi.fn().mockResolvedValue(agent);
    const registry = makeRegistry();

    const runner = new ProactiveTaskRunner(getAgent);
    const task = { id: 't1', prompt: 'query something', cron: '', enabled: true };
    await runner.run(task as any, registry);

    expect(registry.pushSafe).not.toHaveBeenCalled();
    expect(agent.processMessage).toHaveBeenCalledWith('query something');
  });

  it('pushes when task has channel but no chatId (uses adapter defaultChatId)', async () => {
    const agent = makeAgent('Result');
    const getAgent = vi.fn().mockResolvedValue(agent);
    const registry = makeRegistry();

    const runner = new ProactiveTaskRunner(getAgent);
    const task = { id: 't1', prompt: 'test', channel: 'wechat', cron: '', enabled: true };
    await runner.run(task as any, registry);

    expect(registry.pushSafe).toHaveBeenCalledWith('wechat', '', 'Result');
  });

  it('pushes when task has channel and chatId', async () => {
    const agent = makeAgent('Result with push');
    const getAgent = vi.fn().mockResolvedValue(agent);
    const registry = makeRegistry();

    const runner = new ProactiveTaskRunner(getAgent);
    const task = { id: 't1', prompt: 'analyze market', channel: 'feishu', chatId: 'oc_1', cron: '', enabled: true };
    await runner.run(task as any, registry);

    expect(registry.pushSafe).toHaveBeenCalledWith('feishu', 'oc_1', 'Result with push');
  });

  it('does not throw when pushSafe returns false (push failed)', async () => {
    const agent = makeAgent('Result');
    const getAgent = vi.fn().mockResolvedValue(agent);
    const registry = makeRegistry(false); // pushSafe returns false

    const runner = new ProactiveTaskRunner(getAgent);
    await expect(runner.run(
      { id: 't1', prompt: 'test', channel: 'feishu', chatId: 'oc_1', cron: '', enabled: true },
      registry,
    )).resolves.not.toThrow();
  });
});
