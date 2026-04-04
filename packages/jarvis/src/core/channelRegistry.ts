/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type ChannelAdapter = {
  /** Push a message to the given chatId/userId on this channel. */
  push: (chatId: string, text: string) => Promise<void>;
};

/**
 * Registry of communication channels available for proactive task output.
 */
export class ChannelRegistry {
  private static instance: ChannelRegistry;
  private channels = new Map<string, ChannelAdapter>();

  private constructor(private defaultChannel?: string) {}

  public static getInstance(defaultChannel?: string): ChannelRegistry {
    if (!ChannelRegistry.instance) {
      ChannelRegistry.instance = new ChannelRegistry(defaultChannel);
    }
    return ChannelRegistry.instance;
  }

  public register(name: string, adapter: ChannelAdapter): void {
    console.error(`🔌 [ChannelRegistry] Registering channel: ${name}`);
    this.channels.set(name, adapter);
  }

  public isRegistered(name: string): boolean {
    return this.channels.has(name);
  }

  public async push(channel: string, chatId: string, text: string): Promise<void> {
    const adapter = this.channels.get(channel);
    if (!adapter) {
      throw new Error(`Channel "${channel}" not registered in ChannelRegistry.`);
    }
    await adapter.push(chatId, text);
  }

  public async pushDefault(chatId: string, text: string): Promise<void> {
    if (!this.defaultChannel) {
      throw new Error('No default channel configured in ChannelRegistry.');
    }
    await this.push(this.defaultChannel, chatId, text);
  }
}
