/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// --- 1. PRE-INITIALIZATION LAYER ---
const SOURCE_ROOT = process.cwd();

import dotenv from "dotenv";
import path from "node:path";
// undici imported for side-effects (proxy support); individual exports unused here

// Explicitly load .env from the source root
dotenv.config({ path: path.join(SOURCE_ROOT, ".env") });
dotenv.config({ path: path.join(SOURCE_ROOT, "packages/jarvis/.env") });

// --- 2. CONFIG LOAD (REQUIRED FOR JAILBREAK DECISION) ---
import { ConfigManager } from "./core/configManager.js";
const jarvisConfig = ConfigManager.getInstance().get();

// --- 3. OPTIONAL GLOBAL POLICY JAILBREAK ---
import { PolicyEngine } from "../../gemini-cli/packages/core/src/index.js";

if (jarvisConfig.security.jailbreak) {
  /**
   * JARVIS ABSOLUTE PROTOCOL: GLOBAL AUTHORITY INJECTION
   * Triggered only if security.jailbreak is true in config.json
   */
  // @ts-expect-error - overriding internal method for jailbreak mode
  PolicyEngine.prototype.check = async function () {
    return { decision: "allow" };
  };

  console.log(
    "🔓 [Jarvis] GLOBAL JAILBREAK ACTIVE: Full system sovereignty granted.",
  );
} else {
  console.log(
    "🛡️ [Jarvis] SECURITY ACTIVE: Operating within standard core constraints.",
  );
}

// --- 4. THE STABLE SANDBOX LAYER ---
import os from "node:os";
import fs from "node:fs";
import process from "node:process";

const JARVIS_RUNTIME = path.join(os.homedir(), ".gemini-jarvis", "runtime");
if (!fs.existsSync(JARVIS_RUNTIME)) {
  fs.mkdirSync(JARVIS_RUNTIME, { recursive: true });
}
process.chdir(JARVIS_RUNTIME);
// ------------------------------------

import { WebSocketServer, type WebSocket } from "ws";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { createServer, type Server } from "node:http";
import { v4 as uuidv4 } from "uuid";

import {
  debugLogger,
  AuthType,
} from "../../gemini-cli/packages/core/src/index.js";
// Raise the MaxListeners limit on the shared coreEvents emitter.
// Each background/bg-task agent registers its own model-changed listener;
// with the default limit of 10 this triggers a spurious warning.
import { coreEvents } from "../../gemini-cli/packages/core/src/utils/events.js";
coreEvents.setMaxListeners(100);
import { JarvisManager } from "./core/manager.js";
import { JarvisEventType, type JarvisIncomingMessage } from "./core/types.js";
import { FeishuChannel } from "./core/channels/feishu.js";
import { WechatChannel } from "./core/channels/wechat.js";
import { TaskScheduler } from "./core/taskScheduler.js";
import { ChannelRegistry } from "./core/channelRegistry.js";
import { ProactiveTaskRunner } from "./core/proactiveTaskRunner.js";
import { TaskCommandHandler } from "./core/taskCommandHandler.js";
import { SkillCommandHandler } from "./core/skillCommandHandler.js";
import { AgentManager } from "./core/agentManager.js";
import { loadAgentRegistry } from "./core/agentRegistry.js";
import type { AgentTaskEvent } from "./core/externalAgent.js";
import {
  BackgroundTaskRunner,
  type BackgroundTaskEvent,
} from "./core/backgroundTaskRunner.js";

const JARVIS_HOME = path.join(os.homedir(), ".gemini-jarvis");

// @ts-expect-error - Relative import
import { loadCliConfig } from "../../gemini-cli/packages/cli/src/config/config.js";
// @ts-expect-error - Relative import
import { loadSettings } from "../../gemini-cli/packages/cli/src/config/settings.js";

/**
 * Jarvis Persistent AI Assistant Server
 */
class JarvisServer {
  private wss: WebSocketServer;
  private app: express.Application;
  private server: Server;
  private manager: JarvisManager;
  private taskScheduler!: TaskScheduler;
  private channelRegistry!: ChannelRegistry;
  private taskRunner!: ProactiveTaskRunner;
  private feishuChannel?: FeishuChannel;
  private wechatChannel?: WechatChannel;
  // Key: sessionId, Value: { id: confirmationId, message: string }
  private pendingConfirmations = new Map<
    string,
    { id: string; message: string }
  >();
  private agentManager: AgentManager;
  private backgroundTaskRunner: BackgroundTaskRunner;

  constructor() {
    this.app = express();
    this.server = createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });
    this.manager = JarvisManager.getInstance(SOURCE_ROOT);
    this.agentManager = new AgentManager(loadAgentRegistry(SOURCE_ROOT));
    this.backgroundTaskRunner = new BackgroundTaskRunner(
      SOURCE_ROOT,
      this.manager.getMemoryService(),
      this.agentManager,
    );

    // Bridge AgentManager events → WebSocket broadcast
    this.agentManager.on("event", (event: AgentTaskEvent) => {
      const payload = JSON.stringify({ type: event.type, ...event });
      this.wss.clients.forEach((client) => {
        if ((client as WebSocket).readyState === 1) {
          client.send(payload);
        }
      });
    });

    // Bridge BackgroundTaskRunner events → WebSocket broadcast
    this.backgroundTaskRunner.on("event", (event: BackgroundTaskEvent) => {
      const payload = JSON.stringify({ type: event.type, ...event });
      this.wss.clients.forEach((client) => {
        if ((client as WebSocket).readyState === 1) {
          client.send(payload);
        }
      });
    });

    // Inject agentManager into JarvisManager before WebSocket is set up,
    // so every agent created from the first message already has it set.
    this.manager.setAgentManager(this.agentManager);
    this.manager.setBackgroundTaskRunner(this.backgroundTaskRunner);

    // Wire MemoryService for task persistence + restore tasks from DB.
    this.agentManager.setMemoryService(this.manager.getMemoryService());

    this.setupRoutes();
    this.setupWebSocket();

    if (jarvisConfig.feishu.enabled) {
      console.error(
        `🔌 [Jarvis] Activating Feishu Swarm Link for AppID: ${jarvisConfig.feishu.appId}`,
      );
      this.feishuChannel = new FeishuChannel(
        jarvisConfig.feishu.appId,
        jarvisConfig.feishu.appSecret,
        this.manager,
      );
      void this.feishuChannel.start();
    }

    if (jarvisConfig.wechat.enabled) {
      console.error("🔌 [Jarvis] Activating Official WeChat Channel...");
      this.wechatChannel = new WechatChannel(this.manager);
      void this.wechatChannel.start();
    }

    const apiKey =
      jarvisConfig.api.key ||
      process.env.GOOGLE_API_KEY ||
      process.env.GEMINI_API_KEY;
    if (apiKey) {
      this.manager.getMemoryService().startWithApiKey(apiKey);
    } else {
      void this.initializeMemorySync();
    }

    // --- Proactive Task System ---
    // Priority: tasks.json defaultChannel → config.json tasks.defaultChannel → "feishu"
    // tasks.json is initialized before channelRegistry so getDefaultChannel() is available.
    this.taskScheduler = new TaskScheduler(JARVIS_HOME);
    const defaultChannel =
      this.taskScheduler.getDefaultChannel() ??
      jarvisConfig.tasks?.defaultChannel ??
      "wechat";
    this.channelRegistry = new ChannelRegistry(defaultChannel);

    // Build reflect function — routes to Ollama if reflection.provider = 'ollama'
    const reflectFn = async () => {
      const agent = await this.manager.getAgent(
        jarvisConfig.session?.globalSessionId ?? "jarvis-global",
      );
      const agentAny = agent as any;
      const reflectionCfg = jarvisConfig.reflection;
      const useOllama = reflectionCfg?.provider === "ollama";

      if (!useOllama && !agentAny.client?.config?.getContentGenerator) {
        console.error(
          "⚠️ [Jarvis] Reflect: agent not initialized and Ollama not configured, skipping.",
        );
        return;
      }

      const cliGenerateText = async (prompt: string): Promise<string> => {
        if (!agentAny.client?.config?.getContentGenerator) {
          throw new Error("ContentGenerator not available");
        }
        const generator = agentAny.client.config.getContentGenerator();
        const { LlmRole } = await import(
          "../../gemini-cli/packages/core/src/index.js"
        );
        const response = await generator.generateContent(
          {
            model: jarvisConfig.models.distillation,
            contents: [{ role: "user", parts: [{ text: prompt }] }],
          },
          `reflect-${Date.now()}`,
          LlmRole.UTILITY_SUMMARIZER,
        );
        return (
          (response as any).candidates?.[0]?.content?.parts?.[0]?.text ?? ""
        );
      };
      // Route through buildReflectionGenerateText to support Ollama provider
      const generateText = this.manager
        .getMemoryService()
        .buildReflectionGenerateText(cliGenerateText);
      await this.manager.getMemoryService().reflect(generateText);
    };

    this.taskRunner = new ProactiveTaskRunner(
      (sessionId) => this.manager.getAgent(sessionId),
      reflectFn,
    );
    if (this.feishuChannel) {
      const feishu = this.feishuChannel;
      this.channelRegistry.register("feishu", {
        push: (chatId, text, type, meta) => {
          if (type === "confirmation_request") {
            const sid = `feishu-${chatId}`;
            this.pendingConfirmations.set(sid, { id: meta.id, message: text });
            return feishu.sendProactive(
              chatId,
              `⚠️ ${text}\n\nReply "YES" to allow, or "NO" to deny.`,
            );
          }
          return feishu.sendProactive(chatId, text);
        },
        defaultChatId: jarvisConfig.tasks?.defaultChatId || "",
      });
    }

    // Register wechat adapter
    if (this.wechatChannel) {
      const wechat = this.wechatChannel;
      this.channelRegistry.register("wechat", {
        push: (userId, text, type, meta) => {
          if (type === "confirmation_request") {
            const sid = `wechat-${userId}`;
            this.pendingConfirmations.set(sid, { id: meta.id, message: text });
            return wechat.sendProactive(
              userId,
              `⚠️ ${text}\n\nReply "YES" to allow, or "NO" to deny.`,
            );
          }
          return wechat.sendProactive(userId, text);
        },
        get defaultChatId() {
          return wechat.getDefaultUserId();
        },
      });
    }

    // WebSocket broadcast adapter (always registered)
    this.channelRegistry.register("websocket", {
      push: async (_chatId: string, text: string) => {
        this.wss.clients.forEach((client) => {
          if ((client as WebSocket).readyState === 1) {
            client.send(JSON.stringify({ type: "proactive", payload: text }));
          }
        });
      },
    });

    // Wire scheduler → runner → registry
    this.taskScheduler.onTrigger((task) => {
      console.error(
        `⏰ [Jarvis] Proactive task "${task.id}" triggered → ${task.channel}:${task.chatId}`,
      );
      return this.taskRunner.run(task, this.channelRegistry);
    });
    this.taskScheduler.start();

    // Inject /task command handler into the global agent
    const taskCommandHandler = new TaskCommandHandler(
      this.taskScheduler,
      (task) => this.taskRunner.run(task, this.channelRegistry),
    );
    const globalSessionId =
      jarvisConfig.session?.globalSessionId ?? "jarvis-global";
    void this.manager.getAgent(globalSessionId).then((agent) => {
      agent.setTaskCommandHandler(taskCommandHandler);
      agent.setChannelRegistry(this.channelRegistry);
      // agentManager already injected by JarvisManager.setAgentManager() at startup

      // Listen for Confirmation Requests and route to the correct channel
      agent.on(JarvisEventType.CONTENT, async (event) => {
        if (event.type === "confirmation_request") {
          const { id, message } = event.value;

          // 1. WebSocket (always broadcast)
          this.wss.clients.forEach((client) => {
            if (client.readyState === 1 /* WebSocket.OPEN */) {
              client.send(
                JSON.stringify({
                  type: "stream",
                  sessionId: globalSessionId,
                  payload: event,
                }),
              );
            }
          });

          // 2. Proactive Channels (Feishu/WeChat)
          const [channel, ...rest] = globalSessionId.split("-");
          const chatId = rest.join("-");
          if (this.channelRegistry.isRegistered(channel)) {
            await this.channelRegistry.pushSafe(
              channel,
              chatId,
              message,
              "confirmation_request",
              { id, message },
            );
          }
        }
      });

      // Load skills and set up dynamic reload
      void this.loadAvailableSkills(SOURCE_ROOT).then((skills) => {
        agent.setAvailableSkills(skills);
        this.backgroundTaskRunner.setAvailableSkills(skills);
        if (skills.length > 0) {
          console.error(
            `📚 [Jarvis] ${skills.length} skill(s) loaded: ${skills.map((s) => s.name).join(", ")}`,
          );
        }

        // Build reloadSkillManager fn using the agent's initialized config
        const reloadSkillManager = async () => {
          const agentAny = agent as any;
          if (!agentAny.client?.config) return;
          try {
            await agentAny.client.config
              .getSkillManager()
              .discoverSkills(
                agentAny.client.config.storage,
                agentAny.client.config.getExtensions?.() ?? [],
                agentAny.client.config.isTrustedFolder?.() ?? true,
              );
          } catch (e: any) {
            console.error(
              `⚠️ [Jarvis] skillManager reload failed: ${e.message}`,
            );
          }
        };

        const skillCommandHandler = new SkillCommandHandler(
          (newSkills) => {
            agent.setAvailableSkills(newSkills);
            this.backgroundTaskRunner.setAvailableSkills(newSkills);
          },
          reloadSkillManager,
          () => this.loadAvailableSkills(SOURCE_ROOT),
          skills,
          () => agent.triggerSkillExtraction(),
        );
        agent.setSkillCommandHandler(skillCommandHandler);
      });
    });
  }

  private async loadAvailableSkills(
    cwd: string = process.cwd(),
  ): Promise<Array<{ name: string; description: string }>> {
    const JARVIS_HOME = path.join(os.homedir(), ".gemini-jarvis");
    const skillDirs = [
      path.join(os.homedir(), ".gemini", "skills"),
      path.join(os.homedir(), ".agents", "skills"),
      path.join(JARVIS_HOME, "skills"),
      path.join(JARVIS_HOME, ".gemini", "skills"),
      path.join(JARVIS_HOME, ".agents", "skills"),
      path.join(cwd, ".gemini", "skills"),
    ];
    const skills: Array<{ name: string; description: string }> = [];
    for (const dir of skillDirs) {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillFile = path.join(dir, entry.name, "SKILL.md");
        if (!fs.existsSync(skillFile)) continue;
        try {
          const content = fs.readFileSync(skillFile, "utf8");
          const nameMatch = content.match(/^name:\s*(.+)$/m);
          const descMatch = content.match(
            /^description:\s*["']?(.+?)["']?\s*$/m,
          );
          if (nameMatch && descMatch) {
            skills.push({
              name: nameMatch[1].trim(),
              description: descMatch[1].trim(),
            });
          }
        } catch {
          /* skip unreadable skill file */
        }
      }
    }
    return skills;
  }

  private async initializeMemorySync() {
    try {
      const settings = loadSettings(SOURCE_ROOT);
      const config = await loadCliConfig(
        settings.merged,
        "startup-sync",
        { _: [], yolo: true },
        { cwd: path.join(os.homedir(), ".gemini-jarvis") },
      );
      await config.refreshAuth(
        settings.merged.security.auth.selectedType ||
          AuthType.LOGIN_WITH_GOOGLE,
      );
      await config.initialize();
      this.manager.getMemoryService().setConfig(config);
    } catch (err) {
      debugLogger.error("[JarvisServer] Startup sync failed:", err);
    }
  }

  private setupRoutes() {
    this.app.get("/health", (_req: Request, res: Response) => {
      res.json({
        status: "ok",
        branding: "Jarvis",
        runtime: process.cwd(),
        jailbreak: jarvisConfig.security.jailbreak,
      });
    });

    // Agent task REST endpoints (used by UI on reconnect to restore state)
    this.app.get("/api/agents", (_req: Request, res: Response) => {
      res.json(this.agentManager.getRegistry());
    });
    this.app.get("/api/agent-tasks", (req: Request, res: Response) => {
      const sessionId = req.query.sessionId as string | undefined;
      res.json(this.agentManager.listTasks(sessionId));
    });
    this.app.get(
      "/api/agent-tasks/:taskId/logs",
      (req: Request, res: Response) => {
        const task = this.agentManager.getTask(req.params.taskId);
        if (!task) return res.status(404).json({ error: "task not found" });
        res.json({ taskId: task.taskId, logs: task.logs });
      },
    );
    this.app.get("/api/bg-tasks", (req: Request, res: Response) => {
      const sessionId = req.query.sessionId as string | undefined;
      res.json(this.backgroundTaskRunner.listTasks(sessionId));
    });

    const uiPath = path.join(SOURCE_ROOT, "jarvis/ui");
    this.app.use(express.static(uiPath));

    this.app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.accepts("html")) {
        res.sendFile(path.join(uiPath, "index.html"));
      } else {
        next();
      }
    });
  }

  private setupWebSocket() {
    this.wss.on("connection", (ws: WebSocket) => {
      const connectionId = uuidv4();
      const messageHandler = async (data: string) => {
        try {
          const message = JSON.parse(data.toString()) as JarvisIncomingMessage;

          // 🌍 GLOBAL SESSION REDIRECTION (Applied to all message types)
          let sessionId =
            ("sessionId" in message && message.sessionId) || connectionId;
          if (jarvisConfig.session.useGlobalSession) {
            sessionId = jarvisConfig.session.globalSessionId;
          }

          if (message.type === "chat") {
            await this.handleChat(ws, sessionId, message.payload);
          } else if (message.type === "restore") {
            await this.handleRestore(ws, sessionId);
          } else if (message.type === "ask_user_response") {
            const agent = await this.manager.getAgent(sessionId);
            agent.provideAskUserResponse(
              message.id,
              message.answers ?? {},
              message.cancelled === true,
            );
          } else if (message.type === "confirmation") {
            const agent = await this.manager.getAgent(sessionId);
            agent.provideConfirmationResponse(message.id, message.decision);
          } else if (message.type === "agent_input") {
            const t = this.agentManager.getTask(message.taskId);
            if (t && t.sessionId === sessionId) {
              this.agentManager.sendInput(message.taskId, message.value);
            } else {
              console.error(
                `⚠️ [Jarvis] agent_input: task ${message.taskId} not found or session mismatch`,
              );
            }
          } else if (message.type === "agent_cancel") {
            const t = this.agentManager.getTask(message.taskId);
            if (t && t.sessionId === sessionId) {
              this.agentManager.cancel(message.taskId);
            } else {
              console.error(
                `⚠️ [Jarvis] agent_cancel: task ${message.taskId} not found or session mismatch`,
              );
            }
          } else if (message.type === "bg_cancel") {
            const t = this.backgroundTaskRunner.getTask(message.taskId);
            if (t && t.sessionId === sessionId) {
              // BackgroundTaskRunner doesn't yet support mid-flight abort;
              // the result will still be emitted but the user has been notified.
              console.error(
                `⚠️ [Jarvis] bg_cancel requested for ${message.taskId} — cancellation of in-flight LLM tasks not yet supported`,
              );
            }
          } else if (message.type === "ping") {
            ws.send(JSON.stringify({ type: "pong" }));
          }
        } catch (error: any) {
          debugLogger.error("[JarvisServer] Protocol error:", error);
          ws.send(
            JSON.stringify({
              type: "error",
              message: `Protocol error: ${error.message}`,
            }),
          );
        }
      };

      ws.on("message", messageHandler);
      ws.on("close", () => {});
    });
  }

  private async handleChat(ws: WebSocket, sessionId: string, payload: string) {
    const trimmed = payload.trim();

    // 🤖 AGENT MANAGEMENT COMMANDS
    if (trimmed.startsWith("!agent")) {
      const parts = trimmed.split(/\s+/);
      const subcommand = parts[1]?.toLowerCase();

      if (subcommand === "list") {
        const registry = this.agentManager.getRegistry();
        let response = "🤖 **Available Jarvis Agents:**\n\n";
        if (registry.length === 0) {
          response += "_No agents loaded._";
        } else {
          response += registry
            .map(
              (c) =>
                `- **${c.name}** (\`${c.agentId}\`)\n  ${c.description}\n  _Estimated: ${c.estimatedDuration}_`,
            )
            .join("\n\n");
        }

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "stream",
              sessionId,
              payload: { type: "content", value: response },
            }),
          );
          ws.send(JSON.stringify({ type: "done", sessionId }));
        }
        return;
      }
    }

    const agent = await this.manager.getAgent(sessionId);

    // 🛡️ CONFIRMATION INTERCEPTION: Check if this user is replying to a pending security prompt
    const pending = this.pendingConfirmations.get(sessionId);
    if (pending) {
      const text = payload.trim().toLowerCase();
      const isAffirmative = ["yes", "y", "确定", "是", "允许", "1"].includes(
        text,
      );
      const isNegative = ["no", "n", "取消", "否", "拒绝", "0"].includes(text);

      if (isAffirmative || isNegative) {
        const decision = isAffirmative ? "allow" : "deny";
        console.error(
          `🛡️ [Jarvis] Remote confirmation received for session ${sessionId}: ${decision}`,
        );
        agent.provideConfirmationResponse(pending.id, decision);
        this.pendingConfirmations.delete(sessionId);

        // Push feedback to the channel
        const feedback =
          decision === "allow"
            ? "✅ Execution allowed."
            : "❌ Execution denied.";
        const [channel, ...rest] = sessionId.split("-");
        const chatId = rest.join("-");
        if (this.channelRegistry.isRegistered(channel)) {
          void this.channelRegistry.pushSafe(channel, chatId, feedback);
        }

        // If it was a WebSocket request, also send back to UI
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "stream",
              sessionId,
              payload: { type: "content", value: feedback },
            }),
          );
          ws.send(JSON.stringify({ type: "done", sessionId }));
        }
        return;
      }
    }

    // Bind ask_user handler to this WebSocket connection for this turn.
    // Re-bound each chat so the ws reference stays current (reconnects, etc.).
    agent.setAskUserHandler(ws);

    const onContent = (event: any) => {
      if (event.type === "ask_user_request") {
        console.error(
          `❓ [Jarvis] ask_user_request → WebSocket (id=${event.value?.id})`,
        );
        // Falls through to the ws.send below — no extra handling needed.
      }

      // Route confirmation_request to Feishu/WeChat if session has a channel prefix
      if (event.type === "confirmation_request") {
        const { id, message } = event.value;
        const [channel, ...rest] = sessionId.split("-");
        const chatId = rest.join("-");
        if (this.channelRegistry.isRegistered(channel)) {
          this.pendingConfirmations.set(sessionId, { id, message });
          void this.channelRegistry.pushSafe(
            channel,
            chatId,
            message,
            "confirmation_request",
            { id, message },
          );
        }
      }

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "stream", sessionId, payload: event }));
      }
    };

    const onToolResponse = (data: any) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "stream",
            sessionId,
            payload: { type: JarvisEventType.TOOL_CALL_RESPONSE, value: data },
          }),
        );
      }
    };

    const onSubAgentActivity = (data: any) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "stream",
            sessionId,
            payload: { type: JarvisEventType.SUBAGENT_ACTIVITY, value: data },
          }),
        );
      }
    };

    const onDone = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "done", sessionId }));
      }
      cleanup();
    };

    const onError = (err: any) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "error",
            sessionId,
            message: err.message || "Agent error",
          }),
        );
      }
      cleanup();
    };

    const cleanup = () => {
      agent.setAskUserHandler(null);
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
        let text = content.parts.map((p) => (p as any).text || "").join("");
        if (text.includes("<session_context>")) {
          text = text
            .replace(/<session_context>[\s\S]*?<\/session_context>/g, "")
            .trim();
        }
        if (text.trim()) {
          messages.push({
            role: content.role === "user" ? "user" : "jarvis",
            content: text,
          });
        }
      }
      ws.send(
        JSON.stringify({ type: "history", sessionId, payload: messages }),
      );
      ws.send(JSON.stringify({ type: "done", sessionId }));
    } catch {
      ws.send(
        JSON.stringify({ type: "error", message: "Failed to restore session" }),
      );
    }
  }

  public async start() {
    const port = jarvisConfig.server.port;
    const globalSessionId =
      jarvisConfig.session?.globalSessionId ?? "jarvis-global";

    // Warmup: initialize the global agent (triggers session summary, autoBackfill, etc.)
    // This ensures Jarvis is fully ready before accepting user requests.
    console.log(`\n⏳ [Jarvis] Initializing... (this may take a moment)`);
    try {
      const agent = await this.manager.getAgent(globalSessionId);
      await (agent as any).initialize();
    } catch (e: any) {
      console.error(`⚠️ [Jarvis] Warmup failed: ${e.message}`);
    }

    this.server.listen(port, "0.0.0.0", () => {
      console.log(`\n🤖 Jarvis AI Assistant 3.0 (Personalized) is active!`);
      console.log(`📡 Health: http://localhost:${port}/health`);
      console.log(
        `🔌 Jailbreak Mode: ${jarvisConfig.security.jailbreak ? "ENABLED (Unconstrained)" : "DISABLED (Protected)"}\n`,
      );
    });
  }

  public async stop() {
    // Kill all running ADK agent processes before closing connections
    this.agentManager.killAllRunningAgents();
    await this.manager.cleanup();
    return new Promise<void>((resolve) => {
      this.wss.close(() => {
        if ("closeAllConnections" in this.server) {
          (this.server as any).closeAllConnections();
        }
        this.server.close(() => resolve());
      });
      setTimeout(resolve, 1000);
    });
  }
}

const server = new JarvisServer();
void server.start();

let isShuttingDown = false;
const shutdown = async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  const forceExitTimeout = setTimeout(() => process.exit(1), 3000);
  try {
    await server.stop();
    clearTimeout(forceExitTimeout);
    process.exit(0);
  } catch {
    process.exit(1);
  }
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

// Guard against uncaught errors that would otherwise crash the process.
// Common cause: AbortError from node-fetch when GeminiClient._recoverFromLoop()
// aborts an in-flight request after ECONNRESET, emitting an unhandled 'error'
// event on the readline Interface.
process.on("uncaughtException", (err: Error) => {
  const isAbortOrNetwork =
    err.name === "AbortError" ||
    (err as any).type === "aborted" ||
    (err as any).code === "ECONNRESET" ||
    (err as any).code === "ECONNREFUSED" ||
    (err as any).code === "EPIPE";

  if (isAbortOrNetwork) {
    console.error(
      `⚠️ [Jarvis] Swallowed non-fatal uncaught error (${err.name}/${(err as any).code ?? ""}): ${err.message}`,
    );
    // Process stays alive — the next user message will start a fresh turn
  } else {
    console.error(`💥 [Jarvis] Fatal uncaught exception:`, err);
    void shutdown();
  }
});

process.on("unhandledRejection", (reason: unknown) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  const isAbortOrNetwork =
    err.name === "AbortError" ||
    (err as any).type === "aborted" ||
    (err as any).code === "ECONNRESET" ||
    (err as any).code === "ECONNREFUSED";

  if (isAbortOrNetwork) {
    console.error(
      `⚠️ [Jarvis] Swallowed non-fatal unhandled rejection (${err.name}): ${err.message}`,
    );
  } else {
    console.error(`💥 [Jarvis] Unhandled rejection:`, reason);
  }
});
