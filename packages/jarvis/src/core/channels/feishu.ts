/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { JarvisManager } from '../manager.js';
import { JarvisEventType } from '../types.js';
import { debugLogger } from '../../../../core/src/index.js';

export class FeishuChannel {
  private client: lark.Client;
  private wsClient: lark.WSClient;
  private manager: JarvisManager;
  private processedMessages = new Set<string>();
  private startTime = Date.now();

  constructor(appId: string, appSecret: string, manager: JarvisManager) {
    const baseConfig: any = {
      appId,
      appSecret,
      domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.info,
    };

    this.client = new lark.Client(baseConfig);
    this.wsClient = new lark.WSClient(baseConfig);
    this.manager = manager;
  }

  public async start() {
    console.error('\n📡 [Feishu] Swarm Link Online. Monitoring Payload...');
    
    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        const { message } = data;
        const msgId = message.message_id;
        const createTime = parseInt(message.create_time);

        // 🛡️ DEDUPLICATION & HISTORICAL FILTER
        if (this.processedMessages.has(msgId)) {
          console.error(`⚠️ [Feishu] Duplicate message detected: ${msgId}`);
          return;
        }
        
        if (createTime < this.startTime) {
          console.error(`⏳ [Feishu] Ignoring historical message from ${new Date(createTime).toISOString()}`);
          return;
        }

        this.processedMessages.add(msgId);
        
        // Keep the set size manageable
        if (this.processedMessages.size > 1000) {
          const firstItem = this.processedMessages.values().next().value;
          if (firstItem) this.processedMessages.delete(firstItem);
        }

        console.error('\n📦 [Feishu] RAW DATA RECEIVED:', JSON.stringify(data, null, 2));
        
        // Feishu uses 'msg_type' or 'message_type' depending on version/event
        const msgType = message.msg_type || (message as any).message_type;
        const chatId = message.chat_id;
        
        console.error('----------------------------------------');
        console.error(`📩 From Chat: ${chatId}`);
        console.error(`🏷️ Type: ${msgType}`);
        
        if (msgType === 'text') {
          const content = JSON.parse(message.content).text;
          console.error(`💬 Content: ${content}`);
          console.error('----------------------------------------\n');
          
          // 🔥 NON-BLOCKING EXECUTION:
          // We trigger the Jarvis logic in the background and return immediately.
          // This ensures Feishu receives an ACK before its 3-second timeout.
          void this.handleUserMessage(chatId, content, `feishu-${chatId}`);
        } else {
          console.error(`⚠️ Non-text message ignored.`);
          console.error('----------------------------------------\n');
        }

        // Return empty object as ACK for the dispatcher
        return {};
      },
    });

    try {
      await this.wsClient.start({ eventDispatcher });
    } catch (err: any) {
      console.error(`❌ [Feishu] WebSocket Error: ${err.message}`);
    }
  }

  private async handleUserMessage(chatId: string, prompt: string, sessionId: string) {
    try {
      const agent = await this.manager.getAgent(sessionId);
      let responseMessageId = '';
      let accumulatedText = '';

      const resp = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(this.buildCard('Jarvis is thinking...', '🤖 Jarvis Swarm')),
        },
      });
      responseMessageId = resp.data?.message_id || '';

      const updateCard = async (text: string, title: string = '🤖 Jarvis Swarm') => {
        if (!responseMessageId) return;
        try {
          await this.client.im.message.patch({
            path: { message_id: responseMessageId },
            data: { content: JSON.stringify(this.buildCard(text, title)) },
          });
        } catch (e: any) {}
      };

      const contentHandler = (event: any) => {
        accumulatedText += event.value;
        if (accumulatedText.length % 30 === 0 || accumulatedText.length < 50) {
           void updateCard(accumulatedText + ' ▌');
        }
      };

      agent.on(JarvisEventType.CONTENT, contentHandler);
      agent.on(JarvisEventType.DONE, () => {
        void updateCard(accumulatedText);
        agent.removeListener(JarvisEventType.CONTENT, contentHandler);
      });

      await agent.processMessage(prompt);
    } catch (error: any) {
      console.error(`❌ [Feishu] Jarvis Execution Error: ${error.message}`);
    }
  }

  private buildCard(text: string, title: string) {
    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: title },
        template: 'blue',
      },
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: text || '...' } }],
    };
  }
}
