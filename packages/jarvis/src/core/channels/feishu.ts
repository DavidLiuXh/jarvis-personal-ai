/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { JarvisManager } from '../manager.js';
import { JarvisEventType } from '../types.js';
import { debugLogger } from '../../../../core/src/index.js';
import { ConfigManager } from '../configManager.js';

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
    console.error('\n📡 [Feishu] Swarm Link Online. Vision modules enabled.');
    
    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        const { message } = data;
        const msgId = message.message_id;
        const createTime = parseInt(message.create_time);

        if (this.processedMessages.has(msgId)) return;
        if (createTime < this.startTime) return;
        this.processedMessages.add(msgId);

        const msgType = message.msg_type || (message as any).message_type;
        const chatId = message.chat_id;
        
        console.error('----------------------------------------');
        console.error(`📩 From Chat: ${chatId} | Type: ${msgType}`);
        
        if (msgType === 'text') {
          const content = JSON.parse(message.content).text;
          console.error(`💬 Content: ${content}`);
          void this.handleUserMessage(chatId, content, `feishu-${chatId}`);
        } 
        else if (msgType === 'image') {
          const imageKey = JSON.parse(message.content).image_key;
          console.error(`🖼️ Image received: ${imageKey}. Downloading...`);
          void this.handleImageMessage(chatId, imageKey, message.message_id, `feishu-${chatId}`);
        }

        return {};
      },
    });

    try {
      await this.wsClient.start({ eventDispatcher });
    } catch (err: any) {
      console.error(`❌ [Feishu] WebSocket Error: ${err.message}`);
    }
  }

  /**
   * 🛠️ ROBUST STREAM TO BUFFER (Inspired by OpenClaw)
   * Handles multiple Feishu SDK response formats.
   */
  private async getResourceBuffer(response: any): Promise<Buffer> {
    if (Buffer.isBuffer(response)) return response;
    if (response instanceof ArrayBuffer) return Buffer.from(response);
    
    if (response.data) {
      if (Buffer.isBuffer(response.data)) return response.data;
      if (response.data instanceof ArrayBuffer) return Buffer.from(response.data);
    }

    // Handle SDK stream wrapper
    if (typeof response.getReadableStream === 'function') {
      const stream = response.getReadableStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }

    // Fallback to async iterator (if supported)
    if (typeof response[Symbol.asyncIterator] === 'function') {
      const chunks: Buffer[] = [];
      for await (const chunk of response) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }

    throw new Error(`Unexpected Feishu resource format. Keys: [${Object.keys(response).join(', ')}]`);
  }

  private async handleImageMessage(chatId: string, imageKey: string, messageId: string, sessionId: string) {
    try {
      const response = await this.client.im.messageResource.get({
        path: { message_id: messageId, file_key: imageKey },
        params: { type: 'image' },
      });
      
      const buffer = await this.getResourceBuffer(response);
      
      console.error(`✅ Image downloaded (${buffer.length} bytes). Dispatching to Jarvis Vision...`);

      await this.handleUserMessage(chatId, "[Vision Request: Analyzing attached image]", sessionId, {
        data: buffer,
        mimeType: 'image/png'
      });

    } catch (error: any) {
      console.error(`❌ [Feishu] Image processing failed: ${error.message}`);
    }
  }

  private async handleUserMessage(chatId: string, prompt: string, sessionId: string, imageAttachment?: { data: Buffer, mimeType: string }) {
    try {
      const agent = await this.manager.getAgent(sessionId);
      let responseMessageId = '';
      let accumulatedText = '';

      const resp = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(this.buildCard(imageAttachment ? 'Jarvis is looking at your image...' : 'Jarvis is thinking...', '🤖 Jarvis Swarm')),
        },
      });
      responseMessageId = resp.data?.message_id || '';

      const updateCard = async (text: string, title: string = '🤖 Jarvis Swarm') => {
        if (!responseMessageId) return;
        try {
          const jarvisConfig = ConfigManager.getInstance().get();
          await this.client.im.message.patch({
            path: { message_id: responseMessageId },
            data: { content: JSON.stringify(this.buildCard(text, title)) },
          });
        } catch (e: any) {}
      };

      const contentHandler = (event: any) => {
        const jarvisConfig = ConfigManager.getInstance().get();
        if (typeof event.value === 'string') {
          accumulatedText += event.value;
        } else if (jarvisConfig.feishu.showThoughts && event.value && typeof event.value === 'object') {
          const thought = event.value;
          if (thought.subject || thought.description) {
            accumulatedText += `\n> 💭 *${thought.subject || 'Thinking'}: ${thought.description || ''}*\n`;
          }
        }

        if (accumulatedText.length % 30 === 0 || accumulatedText.length < 50) {
           void updateCard(accumulatedText + ' ▌');
        }
      };

      agent.on(JarvisEventType.CONTENT, contentHandler);
      agent.on(JarvisEventType.DONE, () => {
        void updateCard(accumulatedText);
        agent.removeListener(JarvisEventType.CONTENT, contentHandler);
      });

      await agent.processMessage(prompt, imageAttachment);
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
