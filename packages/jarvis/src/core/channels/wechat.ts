/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import qrcode from 'qrcode-terminal';
import { JarvisManager } from '../manager.js';
import { JarvisEventType } from '../types.js';
import { debugLogger } from '../../../../core/src/index.js';
import { ConfigManager } from '../configManager.js';

const SESSION_FILE = path.join(os.homedir(), '.gemini-jarvis', 'wechat_session.json');

interface WechatSession {
  botToken: string;
  baseUrl: string;
  syncBuf: string;
  botId: string;
  userId: string;
}

/**
 * JARVIS WECHAT CHANNEL (Official Plugin Integration)
 */
export class WechatChannel {
  private manager: JarvisManager;
  private session: WechatSession | null = null;
  private isRunning = false;
  private abortController: AbortController | null = null;
  private processedMessages = new Set<string>();
  private startTime = Date.now();

  constructor(manager: JarvisManager) {
    this.manager = manager;
    this.loadSession();
  }

  private loadSession() {
    if (fs.existsSync(SESSION_FILE)) {
      try {
        this.session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
        debugLogger.debug('[Wechat] Loaded existing session for Bot: ' + this.session?.botId);
      } catch (e) {
        this.session = null;
      }
    }
  }

  private saveSession(session: WechatSession) {
    this.session = session;
    fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
  }

  /**
   * Returns the effective base URL: config.wechat.apiBaseUrl takes precedence
   * over session.baseUrl so that IP/domain changes in config are picked up
   * without requiring a re-login.
   */
  private getBaseUrl(): string {
    const config = ConfigManager.getInstance().get();
    const configUrl = config.wechat?.apiBaseUrl;
    const base = (configUrl || this.session?.baseUrl || '').trim();
    return base.endsWith('/') ? base : base + '/';
  }

  /** Proactively send a plain-text message to a user without waiting for user input. */
  public async sendProactive(userId: string, text: string): Promise<void> {
    if (!this.session) {
      throw new Error('[Wechat] Cannot send proactive message: not logged in');
    }
    const res = await fetch(new URL('ilink/bot/sendmessage', this.getBaseUrl()).toString(), {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({
        base_info: { channel_version: '1.0.2' },
        msg: {
          to_user_id: userId,
          client_id: `jarvis-proactive-${Date.now()}`,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text } }],
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`[Wechat] sendProactive failed: HTTP ${res.status}`);
    }
  }

  public async start() {
    if (this.isRunning) return;
    this.isRunning = true;

    if (!this.session) {
      console.error('\n🛡️ [Wechat] No active session found. Initiating Official Secure Login...');
      await this.performLogin();
    }

    if (this.session) {
      console.error('🚀 [Wechat] Swarm Link Online. Monitoring WeChat messages...');
      void this.monitorLoop();
    }
  }

  private async performLogin() {
    const config = ConfigManager.getInstance().get();
    let baseUrl = config.wechat.apiBaseUrl;
    if (!baseUrl.endsWith('/')) baseUrl += '/';

    let loginSuccessful = false;
    while (!loginSuccessful) {
      try {
        const qrResp = await fetch(`${baseUrl}ilink/bot/get_bot_qrcode?bot_type=3`);
        const qrData = await qrResp.json();
        
        console.error('\n' + '='.repeat(40));
        console.error('🛡️ [Wechat] SCAN TO CONNECT (Official Login)');
        console.error('='.repeat(40) + '\n');

        // Use small: false if small: true causes parsing artifacts in some terminals
        qrcode.generate(qrData.qrcode_img_content, { small: true });

        console.error('\n' + '-'.repeat(40));
        console.error('💡 TIP: Use your phone to scan the QR code above.');
        console.error('🔗 OR open this URL if QR is garbled:');
        console.error(qrData.qrcode_img_content);
        console.error('-'.repeat(40) + '\n');
        let qrExpired = false;
        while (!qrExpired && !loginSuccessful) {
          const statusResp = await fetch(`${baseUrl}ilink/bot/get_qrcode_status?qrcode=${qrData.qrcode}`);
          const statusData = await statusResp.json();

          if (statusData.status === 'confirmed') {
            console.error('✅ [Wechat] Login Successful!');
            this.saveSession({
              botToken: statusData.bot_token,
              baseUrl: statusData.baseurl || baseUrl,
              syncBuf: '',
              botId: statusData.ilink_bot_id,
              userId: statusData.ilink_user_id
            });
            loginSuccessful = true;
          } else if (statusData.status === 'expired') {
            console.error('⏳ [Wechat] QR Code expired. Refreshing new code...');
            qrExpired = true;
          } else {
            await new Promise(r => setTimeout(r, 2000));
          }
        }
      } catch (e: any) {
        console.error('❌ [Wechat] Login attempt failed:', e.message);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  private async monitorLoop() {
    this.abortController = new AbortController();
    
    while (this.isRunning && this.session) {
      try {
        const url = new URL('ilink/bot/getupdates', this.getBaseUrl());
        const headers = this.buildHeaders();
        
        const response = await fetch(url.toString(), {
          method: 'POST',
          headers,
          body: JSON.stringify({
            get_updates_buf: this.session.syncBuf,
            base_info: { channel_version: '1.0.2' }
          }),
          signal: this.abortController?.signal
        });

        if (response.status === 200) {
          const data = await response.json();
          const isSuccess = data.ret === 0 || (data.get_updates_buf && data.msgs);

          if (isSuccess || data.msgs?.length > 0) {
            if (data.get_updates_buf && data.get_updates_buf !== this.session.syncBuf) {
              this.session.syncBuf = data.get_updates_buf;
              this.saveSession(this.session);
            }

            if (data.msgs && data.msgs.length > 0) {
              for (const msg of data.msgs) {
                void this.handleIncomingMessage(msg);
              }
            }
          }
        } else {
          await new Promise(r => setTimeout(r, 5000));
        }
      } catch (e: any) {
        if (e.name === 'AbortError') break;
        debugLogger.debug(`[Wechat] Monitor minor ripple: ${e.message}`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  private async handleIncomingMessage(msg: any) {
    const msgId = String(msg.message_id || msg.seq);
    const createTime = msg.create_time_ms || Date.now();

    // 🛡️ DEDUPLICATION
    if (this.processedMessages.has(msgId)) {
      debugLogger.debug(`[Wechat] Skipping duplicate msg: ${msgId}`);
      return;
    }
    this.processedMessages.add(msgId);

    // 🛡️ HISTORICAL FILTER
    if (createTime < this.startTime) {
      return;
    }

    const fromUser = msg.from_user_id;
    const textItem = msg.item_list?.find((i: any) => i.type === 1);
    const contextToken = msg.context_token;

    if (!textItem) return;

    console.error(`📩 [Wechat] Processing mission from [${fromUser}]`);
    
    const sessionId = `wechat-${fromUser}`;
    const agent = await this.manager.getAgent(sessionId);
    let accumulatedText = '';
    
    const reply = async (text: string, isFinish: boolean = false) => {
      if (!text.trim()) return;
      try {
        await fetch(new URL('ilink/bot/sendmessage', this.getBaseUrl()).toString(), {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify({
            base_info: { channel_version: '1.0.2' },
            msg: {
              to_user_id: fromUser,
              client_id: `jarvis-${Date.now()}-${Math.random().toString(36).substring(7)}`,
              message_type: 2,
              message_state: isFinish ? 2 : 1,
              item_list: [{ type: 1, text_item: { text } }],
              context_token: contextToken
            }
          })
        });
      } catch (e) {
        console.error(`❌ [Wechat] Failed to send reply: ${e.message}`);
      }
    };

    // 🛠️ FIX: Proper event handling to avoid duplicate listeners
    const contentHandler = (event: any) => {
      if (typeof event.value === 'string') {
        accumulatedText += event.value;
      }
    };

    // Cleanup function to ensure no listeners leak
    const cleanup = () => {
      agent.removeListener(JarvisEventType.CONTENT, contentHandler);
    };

    agent.on(JarvisEventType.CONTENT, contentHandler);
    
    // Use .once to ensure the reply only fires ONE time per mission
    agent.once(JarvisEventType.DONE, async () => {
      await reply(accumulatedText, true);
      cleanup();
      console.error(`✅ [Wechat] Mission dispatched to [${fromUser}]`);
    });

    agent.once(JarvisEventType.ERROR, async (err: any) => {
      await reply(`⚠️ Jarvis encountered an operational error: ${err.message}`, true);
      cleanup();
    });

    try {
      await agent.processMessage(textItem.text_item.text);
    } catch (e: any) {
      console.error(`❌ [Wechat] Jarvis Execution Error: ${e.message}`);
      cleanup();
    }
  }

  private buildHeaders(): Record<string, string> {
    const uin = Buffer.from(crypto.randomBytes(4).readUInt32BE(0).toString()).toString('base64');
    return {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'X-WECHAT-UIN': uin,
      'Authorization': `Bearer ${this.session?.botToken}`
    };
  }
}
