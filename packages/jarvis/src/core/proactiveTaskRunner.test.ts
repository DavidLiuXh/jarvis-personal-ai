/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProactiveTaskRunner } from './proactiveTaskRunner.js';
import { JarvisEventType } from './types.js';

describe('ProactiveTaskRunner - Refined Reporting', () => {
  let mockAgent: any;
  let mockRegistry: any;
  let runner: ProactiveTaskRunner;

  beforeEach(() => {
    mockAgent = {
      processMessage: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
      removeListener: vi.fn(),
    };
    mockRegistry = {
      push: vi.fn().mockResolvedValue(undefined),
    };
    runner = new ProactiveTaskRunner(async () => mockAgent);
  });

  it('should capture explicit report from deliver_result tool call', async () => {
    const task = { id: 't1', prompt: 'Summarize news', channel: 'wechat', chatId: 'user1' };
    
    mockAgent.processMessage.mockImplementation(async () => {
      const contentHandler = mockAgent.on.mock.calls.find(c => c[0] === JarvisEventType.CONTENT)[1];
      const resultHandler = mockAgent.on.mock.calls.find(c => c[0] === 'deliver_result')[1];
      const doneHandler = mockAgent.once.mock.calls.find(c => c[0] === JarvisEventType.DONE)[1];

      // 1. Emit intermediary thought content (should be ignored)
      contentHandler({ value: 'Searching web...' });
      
      // 2. Emit the explicit delivery signal
      resultHandler({ content: '# Final News Brief\nEverything is great.' });
      
      // 3. Complete mission
      doneHandler();
    });

    await runner.run(task as any, mockRegistry as any);

    // Verify it preferred the explicit tool call content
    expect(mockRegistry.push).toHaveBeenCalledWith('wechat', 'user1', '# Final News Brief\nEverything is great.');
  });

  it('should fallback to last-turn text if deliver_result is missing', async () => {
    const task = { id: 't2', prompt: 'Quick fact', channel: 'feishu', chatId: 'group1' };
    
    mockAgent.processMessage.mockImplementation(async () => {
      const contentHandler = mockAgent.on.mock.calls.find(c => c[0] === JarvisEventType.CONTENT)[1];
      const doneHandler = mockAgent.once.mock.calls.find(c => c[0] === JarvisEventType.DONE)[1];

      // Turn 1
      contentHandler({ value: 'Working...' });
      contentHandler({ type: 'tool-call-request' }); // Trigger reset
      
      // Turn 2 (Final)
      contentHandler({ value: 'The answer is 42.' });
      
      doneHandler();
    });

    await runner.run(task as any, mockRegistry as any);

    expect(mockRegistry.push).toHaveBeenCalledWith('feishu', 'group1', 'The answer is 42.');
  });
});
