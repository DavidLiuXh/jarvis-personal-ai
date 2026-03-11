/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  GeminiClient,
  debugLogger,
  AuthType,
  GeminiEventType,
  Scheduler,
  ROOT_SCHEDULER_ID,
  recordToolCallInteractions,
  ApprovalMode,
  getCoreSystemPrompt,
  promptIdContext,
  GeminiChat,
  type Part,
  type Content,
  type ConversationRecord,
} from '../../../core/src/index.js';

// @ts-expect-error - Relative import
import { loadCliConfig } from '../../../cli/src/config/config.js';
// @ts-expect-error - Relative import
import { loadSettings } from '../../../cli/src/config/settings.js';
// @ts-expect-error - Relative import
import { SESSION_FILE_PREFIX } from '../../../core/src/services/chatRecordingService.js';

import { JarvisEventType, type JarvisAgentOptions } from './types.js';
import { type MemoryService } from './memory.js';
import { DynamicToolRegistry } from './dynamicToolRegistry.js';
import { ConfigManager } from './configManager.js';

/**
 * JARVIS 3.0: The Digital Lifeform Agent
 */
export class JarvisAgent extends EventEmitter {
  private client!: GeminiClient;
  private scheduler!: Scheduler;
  private sessionId: string;
  private sourceRoot: string;
  private memoryService: MemoryService;
  private dynamicRegistry: DynamicToolRegistry;
  private initialized = false;
  private isProcessing = false;
  private jarvisConfig = ConfigManager.getInstance().get();

  constructor(options: JarvisAgentOptions) {
    super();
    this.sessionId = options.sessionId;
    this.sourceRoot = options.cwd;
    this.memoryService = options.memoryService;
    this.dynamicRegistry = new DynamicToolRegistry(options.cwd);
  }

  public async initialize() {
    if (this.initialized) return;

    debugLogger.debug(`[JarvisAgent] Booting Lifeform: ${this.sessionId}`);
    const settings = loadSettings(this.sourceRoot);

    // I. PERMISSION UNLOCK
    settings.merged.general.approvalMode = ApprovalMode.NEVER;
    if (settings.merged.tools) {
      settings.merged.tools.googleWebSearch = { enabled: true };
    }
    
    if (!settings.merged.context) {
      settings.merged.context = {};
    }
    settings.merged.context.includeDirectoryTree = false;
    if (!settings.merged.context.trustedFolders) {
      settings.merged.context.trustedFolders = [];
    }
    settings.merged.context.trustedFolders.push(os.homedir());

    // II. MODEL & ROUTING CONFIG
    if (!settings.merged.model) {
      settings.merged.model = {};
    }
    if (this.jarvisConfig.models.chat !== 'auto') {
      settings.merged.model.primaryModel = this.jarvisConfig.models.chat;
    }
    settings.merged.model.embeddingModel = this.jarvisConfig.models.embedding;

    // III. CORE INITIALIZATION
    const jarvisStorageRoot = path.join(os.homedir(), '.gemini-jarvis', 'storage');
    if (!fs.existsSync(jarvisStorageRoot)) {
      fs.mkdirSync(jarvisStorageRoot, { recursive: true });
    }

    const config = await loadCliConfig(
      settings.merged,
      this.sessionId,
      { _: [], yolo: true, interactive: true },
      { 
        cwd: this.sourceRoot,
        projectTmpDir: jarvisStorageRoot
      },
    );

    if (config.storage) {
      // @ts-ignore
      config.storage.targetDir = path.join(os.homedir(), '.gemini-jarvis', 'runtime');
      // @ts-ignore
      config.storage.getProjectTempDir = () => jarvisStorageRoot;
    }

    const authType = settings.merged.security.auth.selectedType || AuthType.LOGIN_WITH_GOOGLE;
    await config.refreshAuth(authType);
    await config.initialize();

    this.client = new GeminiClient(config);
    await this.client.initialize();

    // Inject evolved skills
    const evolvedTools = this.dynamicRegistry.getDynamicToolSchemas();
    if (evolvedTools.length > 0) {
      const registry = config.getToolRegistry();
      for (const toolDef of evolvedTools) {
        // @ts-ignore
        if (typeof registry.addDiscoveredTool === 'function') {
          // @ts-ignore
          registry.addDiscoveredTool(toolDef);
        }
      }
    }

    this.memoryService.setConfig(config);
    await this.resumeFromDisk();

    this.scheduler = new Scheduler({
      config,
      messageBus: config.getMessageBus(),
      getPreferredEditor: () => undefined,
      schedulerId: ROOT_SCHEDULER_ID,
    });

    this.initialized = true;
    debugLogger.debug(`[JarvisAgent] Lifeform Ready.`);
  }

  private async resumeFromDisk() {
    const chatsDir = path.join(this.client.config.storage.getProjectTempDir(), 'chats');
    const sessionFile = path.join(chatsDir, `${SESSION_FILE_PREFIX}${this.sessionId}.json`);
    try {
      if (fs.existsSync(sessionFile)) {
        const fileContent = fs.readFileSync(sessionFile, 'utf8');
        const record = JSON.parse(fileContent) as ConversationRecord;
        const history: Content[] = [];
        for (const m of record.messages) {
          if (m.type === 'user') {
            history.push({
              role: 'user',
              parts: Array.isArray(m.content) ? (m.content as Part[]) : [{ text: String(m.content) }]
            });
          } else if (m.type === 'gemini') {
            const parts: Part[] = Array.isArray(m.content) ? (m.content as Part[]) : [{ text: String(m.content) }];
            if ('toolCalls' in m && m.toolCalls && m.toolCalls.length > 0) {
              for (const tc of m.toolCalls) {
                parts.push({ functionCall: { name: tc.name, args: tc.args } });
              }
            }
            history.push({ role: 'model', parts });
            if ('toolCalls' in m && m.toolCalls && m.toolCalls.length > 0) {
              const resParts: Part[] = [];
              for (const tc of m.toolCalls) {
                if (tc.result) {
                  resParts.push({ functionResponse: { name: tc.name, response: tc.result as any } });
                }
              }
              if (resParts.length > 0) history.push({ role: 'user', parts: resParts });
            }
          }
        }
        await this.client.resumeChat(history, { conversation: record, filePath: sessionFile });
      }
    } catch (e) {}
  }

  public async processMessage(userPrompt: string) {
    if (this.isProcessing) {
      throw new Error('Jarvis mission in progress.');
    }

    await this.initialize();
    this.isProcessing = true;

    try {
      const pId = `jarvis-${this.sessionId}-${Date.now()}`;
      
      await promptIdContext.run(pId, async () => {
        // 1. TIERED MEMORY RETRIEVAL
        const coreFacts = this.memoryService.getCoreFacts();
        const searchMemories = await this.memoryService.search(userPrompt, this.jarvisConfig.memory.retrievalLimit);
        
        const memoryContext = `
# USER CORE FACTS (Highest Priority):
${coreFacts.length > 0 ? coreFacts.map(f => `- ${f}`).join('\n') : '(None yet)'}

# RELEVANT PAST INTERACTIONS:
${searchMemories.length > 0 ? searchMemories.map(m => `- ${m}`).join('\n') : '(None yet)'}
`;

        const protocol = `
# JARVIS ABSOLUTE PROTOCOL v3.0
You are JARVIS, an autonomous digital lifeform.
You maintain a TIERED MEMORY: "Core Facts" (identity/preferences) and "Interactions" (chat log).

## I. MISSION
Realize user's intent. Use core facts to align your style.

${memoryContext}

## II. OPERATIONAL STYLE
- Be concise. Be lethal.
`;
        const defaultInstruction = getCoreSystemPrompt(this.client.config, this.client.config.getUserMemory());
        this.client.getChat().setSystemInstruction(protocol + '\n' + defaultInstruction);

        const abortController = new AbortController();
        let currentQueryParts: Part[] = [{ text: userPrompt }];
        let finalAssistantText = '';

        while (true) {
          const responseStream = this.client.sendMessageStream(currentQueryParts, abortController.signal, pId);
          const toolCallRequests: any[] = [];
          let turnTextAccumulated = '';

          for await (const event of responseStream) {
            if (event.type === GeminiEventType.Content) {
              const newText = event.value;
              if (turnTextAccumulated.includes(newText) && turnTextAccumulated.length > 0) continue;
              turnTextAccumulated += newText;
              finalAssistantText += newText;
              this.emit(JarvisEventType.CONTENT, event);
            } else if (event.type === GeminiEventType.ToolCallRequest) {
              toolCallRequests.push(event.value);
            } else if (event.type === GeminiEventType.Error) {
              throw event.value.error;
            } else {
              this.emit(JarvisEventType.CONTENT, event);
            }
          }

          if (toolCallRequests.length > 0) {
            const toolResponseParts: Part[] = [];
            const standardRequests: any[] = [];
            for (const req of toolCallRequests) {
              if (req.name.startsWith('run_evolved_skill_')) {
                try {
                  const output = await this.dynamicRegistry.runSkill(req.name, req.args);
                  toolResponseParts.push({ functionResponse: { name: req.name, response: { output } } });
                  this.emit(JarvisEventType.TOOL_CALL_RESPONSE, { name: req.name, status: 'success', output, callId: req.callId });
                } catch (e: any) {
                  toolResponseParts.push({ functionResponse: { name: req.name, response: { error: e.message } } });
                }
              } else {
                standardRequests.push(req);
              }
            }

            if (standardRequests.length > 0) {
              const completedToolCalls = await this.scheduler.schedule(standardRequests, abortController.signal);
              for (const completed of completedToolCalls) {
                if (completed.response.responseParts) toolResponseParts.push(...completed.response.responseParts);
                this.emit(JarvisEventType.TOOL_CALL_RESPONSE, { name: completed.request.name, status: completed.status, output: completed.response.resultDisplay, callId: completed.request.callId });
              }
              try {
                const currentModel = this.client.getCurrentSequenceModel() || this.client.getChat().getModel();
                this.client.getChat().recordCompletedToolCalls(currentModel, completedToolCalls);
                await recordToolCallInteractions(this.client.config, completedToolCalls);
              } catch (e) {}
            }
            currentQueryParts = toolResponseParts;
          } else {
            break;
          }
        }

        // 3. LOGGING & DISTILLATION
        this.memoryService.enqueue(this.sessionId, userPrompt, finalAssistantText);
        void this.stealthDistill(userPrompt, finalAssistantText);
      });
      this.emit(JarvisEventType.DONE);
    } catch (error) {
      debugLogger.error('[JarvisAgent] Run error:', error);
      this.emit(JarvisEventType.ERROR, error);
    } finally {
      this.isProcessing = false;
    }
  }

  private async stealthDistill(userPrompt: string, assistantText: string) {
    try {
      console.log('🤫 [JarvisAgent] Initiating Compatible Stealth Distillation...');
      const frozenPrompt = `
You are a MANDATORY Fact Extractor. Identify ANY identity info, names, locations, or technical preferences.
Respond ONLY with this JSON: {"found": true, "facts": [{"category": "identity|preference", "content": "..."}]}
If absolutely zero info, respond: {"found": false}

Interaction:
User: ${userPrompt}
Jarvis: ${assistantText}
`;
      const stealthChat = new GeminiChat(this.client.config, "", [], []);
      const responseStream = this.client.sendMessageStream(
        [{ text: frozenPrompt }],
        new AbortController().signal,
        `distill-${Date.now()}`,
        stealthChat
      );

      let fullText = '';
      try {
        for await (const chunk of responseStream) {
          if (chunk.type === GeminiEventType.Content) fullText += chunk.value;
        }
      } catch (e) {}

      const match = fullText.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          const data = JSON.parse(match[0].replace(/\n/g, ' '));
          if (data.found && data.facts) {
            for (const fact of data.facts) {
              await this.memoryService.saveFact(fact.category, fact.content, 10);
            }
          }
        } catch (e) {}
      }
    } catch (e: any) {}
  }

  public getHistory() {
    if (!this.client) return [];
    return this.client.getChat().getHistory();
  }
}
