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

  /**
   * TENCENT ILINK LOGIN FLOW
   */
  private async performLogin() {
    const config = ConfigManager.getInstance().get();
    let baseUrl = config.wechat.apiBaseUrl;
    if (!baseUrl.endsWith('/')) baseUrl += '/';

    let loginSuccessful = false;
    while (!loginSuccessful) {
      try {
        // 1. Get QR Code
        const qrResp = await fetch(`${baseUrl}ilink/bot/get_bot_qrcode?bot_type=3`);
        const qrData = await qrResp.json();
        
        console.error('\n🛡️ [Wechat] SCAN TO CONNECT JARVIS TO WECHAT (Official):');
        qrcode.generate(qrData.qrcode_img_content, { small: true });
        console.error('💡 TIP: Use your phone to scan the QR code above.\n');

        // 2. Poll Status
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
            qrExpired = true; // Break inner loop to fetch new QR
          } else {
            // Wait, scanned, etc.
            await new Promise(r => setTimeout(r, 2000));
          }
        }
      } catch (e: any) {
        console.error('❌ [Wechat] Login attempt failed:', e.message);
        console.error('🔄 Retrying login initialization in 5s...');
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  /**
   * LONG POLLING LOOP (Tencent getupdates)
   */
  private async monitorLoop() {
    this.abortController = new AbortController();
    
    while (this.isRunning && this.session) {
      try {
        const url = new URL('ilink/bot/getupdates', this.session.baseUrl);
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
          // DEBUG: Print every poll result
          debugLogger.debug(`[Wechat] Poll result: msgs=${data.msgs?.length || 0}, next_buf=${data.get_updates_buf?.substring(0, 10)}...`);

          // 🛠️ ROBUST SUCCESS CHECK: Proceed if we have a buf or messages, even if ret is undefined
          const isSuccess = data.ret === 0 || (data.get_updates_buf && data.msgs);

          if (isSuccess || data.msgs?.length > 0) {
            // Update Sync Buffer: CRITICAL for receiving next events
            if (data.get_updates_buf && data.get_updates_buf !== this.session.syncBuf) {
              this.session.syncBuf = data.get_updates_buf;
              this.saveSession(this.session);
            }

            if (data.msgs && data.msgs.length > 0) {
              console.error(`🔥 [Wechat] Caught ${data.msgs.length} message(s)! Processing...`);
              for (const msg of data.msgs) {
                // EXTREME DEBUG: Print the exact message structure
                console.error(`📦 [Wechat] RAW MSG Payload: ${JSON.stringify(msg)}`);
                await this.handleIncomingMessage(msg);
              }
            }
          }
        }

 else {
          debugLogger.debug('[Wechat] Connection ripple detected, retrying...');
          await new Promise(r => setTimeout(r, 5000));
        }
      } catch (e: any) {
        if (e.name === 'AbortError') break;
        console.error('⚠️ [Wechat] Monitor loop error:', e.message);
        await new Promise(r => setTimeout(r, 10000)); // Backoff
      }
    }
  }

  private async handleIncomingMessage(msg: any) {
    const fromUser = msg.from_user_id;
    const textItem = msg.item_list?.find((i: any) => i.type === 1); // TEXT = 1
    const imageItem = msg.item_list?.find((i: any) => i.type === 2); // IMAGE = 2
    const contextToken = msg.context_token;

    if (!textItem && !imageItem) return;

    console.error(`📩 [Wechat] New Swarm Intel from [${fromUser}]`);
    
    const sessionId = `wechat-${fromUser}`;
    const agent = await this.manager.getAgent(sessionId);
    
    let accumulatedText = '';
    
    // Wechat requires context_token for all replies
    const reply = async (text: string, isFinish: boolean = false) => {
      try {
        await fetch(new URL('ilink/bot/sendmessage', this.session!.baseUrl).toString(), {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify({
            base_info: { channel_version: '1.0.2' },
            msg: {
              to_user_id: fromUser,
              client_id: `jarvis-${Date.now()}`,
              message_type: 2, // BOT = 2
              message_state: isFinish ? 2 : 1, // FINISH = 2, GENERATING = 1
              item_list: [{ type: 1, text_item: { text } }],
              context_token: contextToken
            }
          })
        });
      } catch (e) {}
    };

    const contentHandler = (event: any) => {
      if (typeof event.value === 'string') {
        accumulatedText += event.value;
        // Optional: Implement incremental updates for WeChat if the gateway supports GENERATING state
      }
    };

    agent.on(JarvisEventType.CONTENT, contentHandler);
    agent.on(JarvisEventType.DONE, async () => {
      await reply(accumulatedText, true);
      agent.removeListener(JarvisEventType.CONTENT, contentHandler);
    });

    // Start Jarvis Mission
    await agent.processMessage(textItem?.text_item?.text || "[Visual Content Provided]");
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
