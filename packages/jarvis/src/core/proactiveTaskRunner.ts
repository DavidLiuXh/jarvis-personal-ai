/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { JarvisEventType } from './types.js';
import type { TriggeredTask } from './taskScheduler.js';
import type { ChannelRegistry } from './channelRegistry.js';

type AgentLike = {
  processMessage: (prompt: string) => Promise<void>;
  on: (event: string, listener: (...args: any[]) => void) => void;
  once: (event: string, listener: (...args: any[]) => void) => void;
  removeListener: (event: string, listener: (...args: any[]) => void) => void;
};

type GetAgentFn = (sessionId: string) => Promise<AgentLike>;

/**
 * Runs proactive tasks by driving the agent without user input.
 * Tasks are queued — only one runs at a time to avoid agent concurrency issues.
 */
export class ProactiveTaskRunner {
  private queue: Array<() => Promise<void>> = [];
  private running = false;

  constructor(private getAgent: GetAgentFn) {}

  public async run(task: TriggeredTask, registry: ChannelRegistry): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(async () => {
        await this.execute(task, registry);
        resolve();
      });
      this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      await next();
    }
    this.running = false;
  }

  private async execute(task: TriggeredTask, registry: ChannelRegistry): Promise<void> {
    console.error(`🤖 [ProactiveTaskRunner] Executing task "${task.id}"...`);
    try {
      // Use global session so the agent has full memory context
      const { ConfigManager } = await import('./configManager.js');
      const config = ConfigManager.getInstance().get();
      const sessionId = config.session?.globalSessionId ?? 'jarvis-global';

      const agent = await this.getAgent(sessionId);
      let accumulatedText = '';

      await new Promise<void>((resolve, reject) => {
        const contentHandler = (event: any) => {
          if (typeof event.value === 'string') {
            accumulatedText += event.value;
          }
        };
        const doneHandler = () => {
          agent.removeListener(JarvisEventType.CONTENT, contentHandler);
          resolve();
        };
        const errorHandler = (err: Error) => {
          agent.removeListener(JarvisEventType.CONTENT, contentHandler);
          reject(err);
        };

        agent.on(JarvisEventType.CONTENT, contentHandler);
        agent.once(JarvisEventType.DONE, doneHandler);
        agent.once(JarvisEventType.ERROR, errorHandler);

        agent.processMessage(task.prompt).catch(reject);
      });

      if (accumulatedText.trim()) {
        await registry.push(task.channel, task.chatId, accumulatedText);
        console.error(`✅ [ProactiveTaskRunner] Task "${task.id}" completed, result pushed to ${task.channel}.`);
      }
    } catch (e: any) {
      const errorMsg = `❌ [Jarvis] Task "${task.id}" failed: ${e.message}`;
      console.error(errorMsg);
      try {
        await registry.push(task.channel, task.chatId, errorMsg);
      } catch (_pushErr) {}
    }
  }
}
