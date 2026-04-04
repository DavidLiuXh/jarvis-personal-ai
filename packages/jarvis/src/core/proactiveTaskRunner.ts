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
 * Implements the "Mission Accomplished" reporting system with fallback.
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
    console.error(`🤖 [ProactiveTaskRunner] Executing mission: "${task.id}"...`);
    try {
      const sessionId = `cron-${task.id}`;
      const agent = await this.getAgent(sessionId);
      
      let finalReport: string | null = null;
      let lastTurnText = '';

      await new Promise<void>((resolve, reject) => {
        // 1. Listen for the explicit delivery tool call
        const resultHandler = (args: any) => {
          console.error(`🎯 [ProactiveTaskRunner] Explicit report captured via deliver_result.`);
          finalReport = args.content;
        };

        // 2. Track incremental text for fallback (last-turn logic)
        const contentHandler = (event: any) => {
          if (typeof event.value === 'string') {
            lastTurnText += event.value;
          } else if (event.type === 'tool-call-request') {
            // Reset on new tool calls to isolate the last turn
            lastTurnText = '';
          }
        };

        const doneHandler = () => {
          cleanup();
          resolve();
        };

        const errorHandler = (err: Error) => {
          cleanup();
          reject(err);
        };

        const cleanup = () => {
          agent.removeListener('deliver_result', resultHandler);
          agent.removeListener(JarvisEventType.CONTENT, contentHandler);
        };

        agent.on('deliver_result', resultHandler);
        agent.on(JarvisEventType.CONTENT, contentHandler);
        agent.once(JarvisEventType.DONE, doneHandler);
        agent.once(JarvisEventType.ERROR, errorHandler);

        agent.processMessage(task.prompt).catch(reject);
      });

      // 🏆 REPORT SELECTION LOGIC
      // Priority 1: Explicit tool call
      // Priority 2: Last turn text (Fallback)
      const reportToPush = finalReport || lastTurnText;

      if (reportToPush && reportToPush.trim()) {
        console.error(`📤 [ProactiveTaskRunner] Pushing final report to ${task.channel}:${task.chatId}`);
        await registry.push(task.channel, task.chatId, reportToPush);
      } else {
        console.error(`⚠️ [ProactiveTaskRunner] Mission complete but no content was generated.`);
      }

    } catch (e: any) {
      const errorMsg = `❌ [Jarvis] Mission Failure [${task.id}]: ${e.message}`;
      console.error(errorMsg);
      try {
        await registry.push(task.channel, task.chatId, errorMsg);
      } catch (_pushErr) {}
    }
  }
}
