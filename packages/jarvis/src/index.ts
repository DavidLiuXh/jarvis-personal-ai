/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// --- 1. PRE-INITIALIZATION LAYER ---
const SOURCE_ROOT = process.cwd();

import dotenv from 'dotenv';
import path from 'node:path';
// Explicitly load .env from the source root
dotenv.config({ path: path.join(SOURCE_ROOT, '.env') });
dotenv.config({ path: path.join(SOURCE_ROOT, 'packages/jarvis/.env') });

// --- 2. THE STABLE SANDBOX LAYER ---
import os from 'node:os';
import fs from 'node:fs';
import process from 'node:process';

/**
 * JARVIS RUNTIME SANDBOX
 */
const JARVIS_RUNTIME = path.join(os.homedir(), '.gemini-jarvis', 'runtime');
if (!fs.existsSync(JARVIS_RUNTIME)) {
  fs.mkdirSync(JARVIS_RUNTIME, { recursive: true });
}

// SWITCH CWD TO SANDBOX
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

  constructor(private port: number = 3000) {
    this.app = express();
    this.server = createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });
    this.manager = JarvisManager.getInstance(SOURCE_ROOT);

    this.setupRoutes();
    this.setupWebSocket();

    const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    if (apiKey) {
      debugLogger.debug('[JarvisServer] API Key found, starting Memory Service.');
      this.manager.getMemoryService().startWithApiKey(apiKey);
    } else {
      void this.initializeMemorySync();
    }
  }

  private async initializeMemorySync() {
    try {
      debugLogger.debug('[JarvisServer] API Key missing in process.env, trying Config discovery...');
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
      res.json({ status: 'ok', branding: 'Jarvis', runtime: process.cwd() });
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
      debugLogger.debug(`[JarvisServer] Connection opened: ${connectionId}`);

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
        } catch (error: unknown) {
          debugLogger.error('[JarvisServer] Msg handle error:', error);
          ws.send(JSON.stringify({ type: 'error', message: 'Protocol error' }));
        }
      };

      ws.on('message', messageHandler);
      ws.on('close', () => {
        debugLogger.debug(`[JarvisServer] Connection closed: ${connectionId}`);
      });
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
      agent.off(JarvisEventType.DONE, onDone);
      agent.off(JarvisEventType.ERROR, onError);
    };

    agent.on(JarvisEventType.CONTENT, onContent);
    agent.on(JarvisEventType.TOOL_CALL_RESPONSE, onToolResponse);
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
      debugLogger.error('[Jarvis] Restore error:', error);
      ws.send(JSON.stringify({ type: 'error', message: 'Failed to restore session' }));
    }
  }

  public start() {
    this.server.listen(this.port, '0.0.0.0', () => {
      // eslint-disable-next-line no-console
      console.log(`\n🤖 Jarvis AI Assistant 3.0 (STRICT ISOLATION) is active!`);
      // eslint-disable-next-line no-console
      console.log(`📡 Health: http://localhost:${this.port}/health`);
      // eslint-disable-next-line no-console
      console.log(`🖥️ Web UI: http://localhost:${this.port}/`);
      // eslint-disable-next-line no-console
      console.log(`🔌 WebSocket: ws://0.0.0.0:${this.port}/\n`);
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

const port = Number(process.env['JARVIS_PORT']) || 3000;
const server = new JarvisServer(port);
server.start();

let isShuttingDown = false;
const shutdown = async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  // eslint-disable-next-line no-console
  console.log('\nShutting down Jarvis gracefully...');
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
