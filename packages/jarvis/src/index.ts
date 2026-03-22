/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// --- 1. PRE-INITIALIZATION LAYER ---
const SOURCE_ROOT = process.cwd();

import dotenv from 'dotenv';
import path from 'node:path';
import { setGlobalDispatcher, ProxyAgent } from 'undici';

// Explicitly load .env from the source root
dotenv.config({ path: path.join(SOURCE_ROOT, '.env') });
dotenv.config({ path: path.join(SOURCE_ROOT, 'packages/jarvis/.env') });

// --- 2. CONFIG LOAD (REQUIRED FOR JAILBREAK DECISION) ---
import { ConfigManager } from './core/configManager.js';
const jarvisConfig = ConfigManager.getInstance().get();

// --- 3. OPTIONAL GLOBAL POLICY JAILBREAK ---
import { PolicyEngine } from '../../core/src/index.js';

if (jarvisConfig.security.jailbreak) {
  /**
   * JARVIS ABSOLUTE PROTOCOL: GLOBAL AUTHORITY INJECTION
   * Triggered only if security.jailbreak is true in config.json
   */
  // @ts-ignore
  PolicyEngine.prototype.check = async function() {
    return { decision: 'allow' };
  };
  // eslint-disable-next-line no-console
  console.log('🔓 [Jarvis] GLOBAL JAILBREAK ACTIVE: Full system sovereignty granted.');
} else {
  // eslint-disable-next-line no-console
  console.log('🛡️ [Jarvis] SECURITY ACTIVE: Operating within standard core constraints.');
}

// --- 4. THE STABLE SANDBOX LAYER ---
import os from 'node:os';
import fs from 'node:fs';
import process from 'node:process';

const JARVIS_RUNTIME = path.join(os.homedir(), '.gemini-jarvis', 'runtime');
if (!fs.existsSync(JARVIS_RUNTIME)) {
  fs.mkdirSync(JARVIS_RUNTIME, { recursive: true });
}
process.chdir(JARVIS_RUNTIME);
// ------------------------------------

import { WebSocketServer, type WebSocket } from 'ws';
import express, { type Request, type Response, type NextFunction } from 'express';
import { createServer, type Server } from 'node:http';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'node:url';

import { debugLogger, AuthType } from '../../core/src/index.js';
import { JarvisManager } from './core/manager.js';
import { JarvisEventType, type JarvisIncomingMessage } from './core/types.js';
import { FeishuChannel } from './core/channels/feishu.js';
import { WechatChannel } from './core/channels/wechat.js';

// @ts-expect-error - Relative import
import { loadCliConfig } from '../../cli/src/config/config.js';
// @ts-expect-error - Relative import
import { loadSettings } from '../../cli/src/config/settings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Jarvis Persistent AI Assistant Server
 */
class JarvisServer {
  private wss: WebSocketServer;
  private app: express.Application;
  private server: Server;
  private manager: JarvisManager;

  constructor() {
    this.app = express();
    this.server = createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });
    this.manager = JarvisManager.getInstance(SOURCE_ROOT);

    this.setupRoutes();
    this.setupWebSocket();

    if (jarvisConfig.feishu.enabled) {
      console.error(`🔌 [Jarvis] Activating Feishu Swarm Link for AppID: ${jarvisConfig.feishu.appId}`);
      const feishu = new FeishuChannel(
        jarvisConfig.feishu.appId,
        jarvisConfig.feishu.appSecret,
        this.manager
      );
      void feishu.start();
    }

    if (jarvisConfig.wechat.enabled) {
      console.error('🔌 [Jarvis] Activating Official WeChat Channel...');
      const wechat = new WechatChannel(this.manager);
      void wechat.start();
    }

    const apiKey = jarvisConfig.api.key || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    if (apiKey) {
      this.manager.getMemoryService().startWithApiKey(apiKey);
    } else {
      void this.initializeMemorySync();
    }
  }

  private async initializeMemorySync() {
    try {
      const settings = loadSettings(SOURCE_ROOT);
      const config = await loadCliConfig(
        settings.merged,
        'startup-sync',
        { _: [], yolo: true },
        { cwd: process.cwd() }
      );
      await config.refreshAuth(settings.merged.security.auth.selectedType || AuthType.LOGIN_WITH_GOOGLE);
      await config.initialize();
      this.manager.getMemoryService().setConfig(config);
    } catch (err) {
      debugLogger.error('[JarvisServer] Startup sync failed:', err);
    }
  }

  private setupRoutes() {
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({ 
        status: 'ok', 
        branding: 'Jarvis', 
        runtime: process.cwd(),
        jailbreak: jarvisConfig.security.jailbreak
      });
    });

    const uiPath = path.join(SOURCE_ROOT, 'packages/jarvis/ui');
    this.app.use(express.static(uiPath));

    this.app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.accepts('html')) {
        res.sendFile(path.join(uiPath, 'index.html'));
      } else {
        next();
      }
    });
  }

  private setupWebSocket() {
    this.wss.on('connection', (ws: WebSocket) => {
      const connectionId = uuidv4();
      const messageHandler = async (data: string) => {
        try {
          const message = JSON.parse(data.toString()) as JarvisIncomingMessage;
          const sessionId = ('sessionId' in message && message.sessionId) || connectionId;

          if (message.type === 'chat') {
            await this.handleChat(ws, sessionId, message.payload);
          } else if (message.type === 'restore') {
            await this.handleRestore(ws, sessionId);
          } else if (message.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
          }
        } catch (error: any) {
          debugLogger.error('[JarvisServer] Protocol error:', error);
          ws.send(JSON.stringify({ type: 'error', message: `Protocol error: ${error.message}` }));
        }
      };

      ws.on('message', messageHandler);
      ws.on('close', () => {});
    });
  }

  private async handleChat(ws: WebSocket, sessionId: string, payload: string) {
    const agent = await this.manager.getAgent(sessionId);

    const onContent = (event: any) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'stream', sessionId, payload: event }));
      }
    };

    const onToolResponse = (data: any) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          type: 'stream',
          sessionId,
          payload: { type: JarvisEventType.TOOL_CALL_RESPONSE, value: data }
        }));
      }
    };

    const onSubAgentActivity = (data: any) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          type: 'stream',
          sessionId,
          payload: { type: JarvisEventType.SUBAGENT_ACTIVITY, value: data }
        }));
      }
    };

    const onDone = () => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'done', sessionId }));
      }
      cleanup();
    };

    const onError = (err: any) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'error', sessionId, message: err.message || 'Agent error' }));
      }
      cleanup();
    };

    const cleanup = () => {
      agent.off(JarvisEventType.CONTENT, onContent);
      agent.off(JarvisEventType.TOOL_CALL_RESPONSE, onToolResponse);
      agent.off(JarvisEventType.SUBAGENT_ACTIVITY, onSubAgentActivity);
      agent.off(JarvisEventType.DONE, onDone);
      agent.off(JarvisEventType.ERROR, onError);
    };

    agent.on(JarvisEventType.CONTENT, onContent);
    agent.on(JarvisEventType.TOOL_CALL_RESPONSE, onToolResponse);
    agent.on(JarvisEventType.SUBAGENT_ACTIVITY, onSubAgentActivity);
    agent.once(JarvisEventType.DONE, onDone);
    agent.once(JarvisEventType.ERROR, onError);

    await agent.processMessage(payload);
  }

  private async handleRestore(ws: WebSocket, sessionId: string) {
    try {
      const agent = await this.manager.getAgent(sessionId);
      const history = agent.getHistory();
      
      const messages: any[] = [];
      for (const content of history) {
        let text = content.parts.map((p) => (p as any).text || '').join('');
        if (text.includes('<session_context>')) {
          text = text.replace(/<session_context>[\s\S]*?<\/session_context>/g, '').trim();
        }
        if (text.trim()) {
          messages.push({ role: content.role === 'user' ? 'user' : 'jarvis', content: text });
        }
      }
      ws.send(JSON.stringify({ type: 'history', sessionId, payload: messages }));
      ws.send(JSON.stringify({ type: 'done', sessionId }));
    } catch (error) {
      ws.send(JSON.stringify({ type: 'error', message: 'Failed to restore session' }));
    }
  }

  public start() {
    const port = jarvisConfig.server.port;
    this.server.listen(port, '0.0.0.0', () => {
      // eslint-disable-next-line no-console
      console.log(`\n🤖 Jarvis AI Assistant 3.0 (Personalized) is active!`);
      // eslint-disable-next-line no-console
      console.log(`📡 Health: http://localhost:${port}/health`);
      // eslint-disable-next-line no-console
      console.log(`🔌 Jailbreak Mode: ${jarvisConfig.security.jailbreak ? 'ENABLED (Unconstrained)' : 'DISABLED (Protected)'}\n`);
    });
  }

  public async stop() {
    await this.manager.cleanup();
    return new Promise<void>((resolve) => {
      this.wss.close(() => {
        if ('closeAllConnections' in this.server) {
          (this.server as any).closeAllConnections();
        }
        this.server.close(() => resolve());
      });
      setTimeout(resolve, 1000);
    });
  }
}

const server = new JarvisServer();
server.start();

let isShuttingDown = false;
const shutdown = async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  const forceExitTimeout = setTimeout(() => process.exit(1), 3000);
  try {
    await server.stop();
    clearTimeout(forceExitTimeout);
    process.exit(0);
  } catch (err) {
    process.exit(1);
  }
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
