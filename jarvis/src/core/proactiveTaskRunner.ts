/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { JarvisEventType } from "./types.js";
import type { TriggeredTask } from "./taskScheduler.js";
import type { ChannelRegistry } from "./channelRegistry.js";

type AgentLike = {
  processMessage: (
    prompt: string,
    imageAttachment?: { data: Buffer; mimeType: string },
    options?: { executionContext?: "interactive" | "proactive_task" },
  ) => Promise<void>;
  on: (event: string, listener: (...args: any[]) => void) => void;
  once: (event: string, listener: (...args: any[]) => void) => void;
  removeListener: (event: string, listener: (...args: any[]) => void) => void;
};

type GetAgentFn = (sessionId: string) => Promise<AgentLike>;

type ReflectFn = () => Promise<void>;

/**
 * Runs proactive tasks by driving the agent without user input.
 * Tasks are queued — only one runs at a time to avoid agent concurrency issues.
 */
export class ProactiveTaskRunner {
  private queue: Array<() => Promise<void>> = [];
  private running = false;

  constructor(
    private getAgent: GetAgentFn,
    private reflect?: ReflectFn,
  ) {}

  public async run(
    task: TriggeredTask,
    registry: ChannelRegistry,
  ): Promise<void> {
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

  private async execute(
    task: TriggeredTask,
    registry: ChannelRegistry,
  ): Promise<void> {
    console.error(`🤖 [ProactiveTaskRunner] Executing task "${task.id}"...`);

    // Handle reflect tasks separately — no agent, no push
    if (task.type === "reflect") {
      if (this.reflect) {
        await this.reflect();
        console.error(
          `✅ [ProactiveTaskRunner] Reflection task "${task.id}" completed.`,
        );
      } else {
        console.error(
          `⚠️ [ProactiveTaskRunner] Reflection task "${task.id}" skipped — reflect fn not available.`,
        );
      }
      return;
    }

    try {
      // Use global session so the agent has full memory context
      const { ConfigManager } = await import("./configManager.js");
      const config = ConfigManager.getInstance().get();
      const sessionId = config.session?.globalSessionId ?? "jarvis-global";

      const agent = await this.getAgent(sessionId);
      let accumulatedText = "";
      let deliveryChannel = task.channel;
      let deliveryChatId = task.chatId ?? "";
      if (
        deliveryChannel &&
        !registry.isRegistered(deliveryChannel) &&
        registry.isRegistered("websocket")
      ) {
        console.error(
          `⚠️ [ProactiveTaskRunner] Channel "${deliveryChannel}" not registered; falling back to websocket for task "${task.id}".`,
        );
        deliveryChannel = "websocket";
        deliveryChatId = "";
      }

      await new Promise<void>((resolve, reject) => {
        const contentHandler = (event: any) => {
          if (typeof event.value === "string") {
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

        // If the task has a delivery channel, prepend explicit instructions:
        // 1. Mention push_to_channel so refreshContext injects the protocol
        //    while avoiding schedule/reminder wording in the visible prompt.
        // 2. Immediately clarify NOT to call it — the runner pushes automatically.
        // Without this, LLM has no knowledge of push_to_channel and tries to
        // use run_shell_command or looks for executables in /usr/bin.
        const prompt = deliveryChannel
          ? `[PROACTIVE TASK — delivery channel: ${deliveryChannel}]\nIMPORTANT: Do NOT call push_to_channel. The system will deliver your response to ${deliveryChannel} after you finish. Just generate the content.\n\n${task.prompt}`
          : task.prompt;
        agent
          .processMessage(prompt, undefined, {
            executionContext: "proactive_task",
          })
          .catch(reject);
      });

      if (accumulatedText.trim()) {
        if (deliveryChannel) {
          // chatId may be empty — pushSafe will fall back to adapter.defaultChatId
          const pushed = await registry.pushSafe(
            deliveryChannel,
            deliveryChatId,
            accumulatedText,
          );
          if (pushed) {
            console.error(
              `✅ [ProactiveTaskRunner] Task "${task.id}" completed, result pushed to ${deliveryChannel}.`,
            );
          } else if (
            deliveryChannel !== "websocket" &&
            registry.isRegistered("websocket") &&
            (await registry.pushSafe("websocket", "", accumulatedText))
          ) {
            console.error(
              `✅ [ProactiveTaskRunner] Task "${task.id}" completed, primary push to ${deliveryChannel} failed, result pushed to websocket.`,
            );
          } else {
            console.error(
              `⚠️ [ProactiveTaskRunner] Task "${task.id}" completed but push to ${deliveryChannel} failed.`,
            );
          }
        } else {
          console.error(
            `✅ [ProactiveTaskRunner] Task "${task.id}" completed (no push configured).`,
          );
        }
      }
    } catch (e: any) {
      const errorMsg = `❌ [Jarvis] Task "${task.id}" failed: ${e.message}`;
      console.error(errorMsg);
      if (task.channel) {
        await registry.pushSafe(task.channel, task.chatId ?? "", errorMsg);
      }
    }
  }
}
