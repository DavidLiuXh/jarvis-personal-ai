/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type ChannelAdapter = {
  /** Push a message to the given chatId/userId on this channel. */
  push: (
    chatId: string,
    text: string,
    type?: string,
    meta?: any,
  ) => Promise<void>;
  /**
   * Default chatId/userId to use when the task does not specify one.
   * For WeChat: the logged-in user's ID from session.
   * For Feishu: the configured defaultChatId.
   */
  defaultChatId?: string;
};

/**
 * Registry of communication channels available for proactive task output.
 * Each channel is identified by a string key (e.g. 'feishu', 'wechat', 'websocket').
 */
export class ChannelRegistry {
  private channels = new Map<string, ChannelAdapter>();

  constructor(private defaultChannel?: string) {}

  public register(name: string, adapter: ChannelAdapter): void {
    this.channels.set(name, adapter);
  }

  public isRegistered(name: string): boolean {
    return this.channels.has(name);
  }

  public async push(
    channel: string,
    chatId: string,
    text: string,
    type?: string,
    meta?: any,
  ): Promise<void> {
    const adapter = this.channels.get(channel);
    if (!adapter) {
      throw new Error(
        `Channel "${channel}" not registered in ChannelRegistry.`,
      );
    }
    await adapter.push(chatId, text, type, meta);
  }

  public async pushDefault(
    chatId: string,
    text: string,
    type?: string,
    meta?: any,
  ): Promise<void> {
    if (!this.defaultChannel) {
      throw new Error("No default channel configured in ChannelRegistry.");
    }
    await this.push(this.defaultChannel, chatId, text, type, meta);
  }

  /**
   * Safe push: returns true on success, false on any failure.
   * When chatId is empty, falls back to adapter.defaultChatId if available.
   * Never throws. Logs a warning on failure.
   */
  public async pushSafe(
    channel: string,
    chatId: string,
    text: string,
    type?: string,
    meta?: any,
  ): Promise<boolean> {
    try {
      const adapter = this.channels.get(channel);
      if (!adapter) {
        console.error(
          `⚠️ [ChannelRegistry] Channel "${channel}" not registered — push skipped.`,
        );
        return false;
      }
      const resolvedChatId = chatId || adapter.defaultChatId || "";
      if (!resolvedChatId) {
        console.error(
          `⚠️ [ChannelRegistry] No chatId for channel "${channel}" — push skipped.`,
        );
        return false;
      }
      await adapter.push(resolvedChatId, text, type, meta);
      return true;
    } catch (e: any) {
      console.error(
        `⚠️ [ChannelRegistry] Push to "${channel}" failed: ${e.message}`,
      );
      return false;
    }
  }
}
