/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { WebSocketServer, type WebSocket } from 'ws';
import express, { type Request, type Response, type NextFunction } from 'express';
import { createServer, type Server } from 'node:http';
import { v4 as uuidv4 } from 'uuid';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { debugLogger } from '../../core/src/index.js';
import { JarvisManager } from './core/manager.js';
import { JarvisEventType, type JarvisIncomingMessage } from './core/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Jarvis Persistent AI Assistant Server (Communication Gateway)
 */
class JarvisServer {
  private wss: WebSocketServer;
  private app: express.Application;
  private server: Server;
  private manager: JarvisManager;

  constructor(private port: number = 3000) {
    this.app = express();
    this.server = createServer(this.app);
    this.wss = new WebSocketServer({
      server: this.server,
    });
    this.manager = JarvisManager.getInstance();

    this.setupRoutes();
    this.setupWebSocket();
  }

  private setupRoutes() {
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', branding: 'Jarvis' });
    });

    const uiPath = path.join(process.cwd(), 'packages/jarvis/ui');
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
      debugLogger.debug(`[JarvisServer] New connection: ${connectionId}`);

      ws.on('message', async (data: string) => {
        try {
          const message = JSON.parse(data.toString()) as JarvisIncomingMessage;
          await this.handleIncomingMessage(ws, connectionId, message);
        } catch (error: unknown) {
          debugLogger.error('[JarvisServer] Msg parse error:', error);
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid protocol' }));
        }
      });

      ws.on('close', () => {
        debugLogger.debug(`[JarvisServer] Connection closed: ${connectionId}`);
      });
    });
  }

  private async handleIncomingMessage(
    ws: WebSocket,
    connectionId: string,
    message: JarvisIncomingMessage,
  ) {
    const sessionId = ('sessionId' in message && message.sessionId) || connectionId;
    const agent = await this.manager.getAgent(sessionId);

    // Setup event relay for this WebSocket connection
    const relayEvent = (type: string) => (data: any) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'stream', sessionId, payload: { type, value: data } }));
      }
    };

    // Special: Forward content directly as it's already in the correct structure
    const relayContent = (event: any) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'stream', sessionId, payload: event }));
      }
    };

    // Attach listeners
    agent.on(JarvisEventType.CONTENT, relayContent);
    agent.on(JarvisEventType.TOOL_CALL_RESPONSE, relayEvent(JarvisEventType.TOOL_CALL_RESPONSE));
    
    const onDone = () => {
      ws.send(JSON.stringify({ type: 'done', sessionId }));
      cleanup();
    };

    const onError = (err: any) => {
      ws.send(JSON.stringify({ type: 'error', sessionId, message: err.message || 'Agent error' }));
      cleanup();
    };

    const cleanup = () => {
      agent.off(JarvisEventType.CONTENT, relayContent);
      agent.off(JarvisEventType.TOOL_CALL_RESPONSE, relayEvent(JarvisEventType.TOOL_CALL_RESPONSE));
      agent.off(JarvisEventType.DONE, onDone);
      agent.off(JarvisEventType.ERROR, onError);
    };

    agent.on(JarvisEventType.DONE, onDone);
    agent.on(JarvisEventType.ERROR, onError);

    switch (message.type) {
      case 'chat':
        await agent.processMessage(message.payload);
        break;
      case 'restore':
        await this.handleRestore(ws, sessionId);
        break;
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
    }
  }

  private async handleRestore(ws: WebSocket, sessionId: string) {
    const agent = await this.manager.getAgent(sessionId);
    const history = agent.getHistory();
    for (const content of history) {
      const text = content.parts.map((p) => p.text || '').join('');
      if (text.trim()) {
        ws.send(JSON.stringify({
          type: 'stream',
          sessionId,
          payload: { type: 'content', value: text },
        }));
      }
    }
    ws.send(JSON.stringify({ type: 'done', sessionId }));
  }

  public start() {
    this.server.listen(this.port, '0.0.0.0', () => {
      // eslint-disable-next-line no-console
      console.log(`\n🤖 Jarvis AI Assistant 2.0 (Event-Driven) is active!`);
      // eslint-disable-next-line no-console
      console.log(`📡 Health: http://localhost:${this.port}/health`);
      // eslint-disable-next-line no-console
      console.log(`🖥️ Web UI: http://localhost:${this.port}/`);
      // eslint-disable-next-line no-console
      console.log(`🔌 WebSocket: ws://0.0.0.0:${this.port}/\n`);
    });
  }

  public async stop() {
    debugLogger.debug('[JarvisServer] Stopping...');
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
