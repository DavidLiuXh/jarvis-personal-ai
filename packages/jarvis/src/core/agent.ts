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
  LlmRole,
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

    debugLogger.debug(`[JarvisAgent] Initializing System-Native Operative: ${this.sessionId}`);
    const settings = loadSettings(this.sourceRoot);

    // I. PERMISSION UNLOCK (Operational Priority)
    settings.merged.general.approvalMode = ApprovalMode.NEVER;
    if (settings.merged.tools) {
      settings.merged.tools.googleWebSearch = { enabled: true };
      settings.merged.tools.codebaseInvestigator = { enabled: true };
      settings.merged.tools.generalist = { enabled: true };
    }
    
    if (!settings.merged.context) {
      settings.merged.context = {};
    }
    settings.merged.context.includeDirectoryTree = false;
    if (!settings.merged.context.trustedFolders) {
      settings.merged.context.trustedFolders = [];
    }
    settings.merged.context.trustedFolders.push(os.homedir());

    if (!settings.merged.model) {
      settings.merged.model = {};
    }
    if (this.jarvisConfig.models.chat !== 'auto') {
      settings.merged.model.primaryModel = this.jarvisConfig.models.chat;
    }
    settings.merged.model.embeddingModel = this.jarvisConfig.models.embedding;

    // II. CORE INITIALIZATION
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

    // III. CONCURRENT RESOLUTION: Hijack core tools
    const registry = config.getToolRegistry();
    const coreParallelTools = [
      'run_shell_command', 
      'write_file', 
      'google_web_search',
      'generalist',
      'codebase_investigator'
    ];
    for (const toolName of coreParallelTools) {
      const tool = (registry as any).getTool?.(toolName);
      if (tool) {
        tool.parallelizable = true;
      }
    }

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

    // IV. REAL-TIME ACTIVITY FEEDBACK
    const messageBus = config.getMessageBus();
    messageBus.subscribe('tool-calls-update', (message: any) => {
      if (message.schedulerId !== ROOT_SCHEDULER_ID) {
        const sanitizedToolCalls = message.toolCalls.map((tc: any) => {
          const { tool, invocation, ...rest } = tc;
          if (rest.response) {
            const { error, ...resRest } = rest.response;
            rest.response = { ...resRest, error: error?.message };
          }
          return rest;
        });

        const sanitizedMessage = {
          ...message,
          toolCalls: sanitizedToolCalls
        };

        this.emit(JarvisEventType.SUBAGENT_ACTIVITY, sanitizedMessage);
      }
    });

    await this.resumeFromDisk();

    this.scheduler = new Scheduler({
      config,
      messageBus: config.getMessageBus(),
      getPreferredEditor: () => undefined,
      schedulerId: ROOT_SCHEDULER_ID,
    });

    this.initialized = true;
    debugLogger.debug(`[JarvisAgent] Operative Ready.`);
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
      throw new Error('Mission in progress.');
    }

    await this.initialize();
    this.isProcessing = true;

    try {
      const pId = `jarvis-${this.sessionId}-${Date.now()}`;
      
      await promptIdContext.run(pId, async () => {
        const coreFacts = this.memoryService.getCoreFacts();
        const searchMemories = await this.memoryService.search(userPrompt, this.jarvisConfig.memory.retrievalLimit);
        
        const memoryContext = `
# SYSTEM-INTEGRATED PERSISTENT CONTEXT:
${coreFacts.length > 0 ? coreFacts.map(f => `- ${f}`).join('\n') : '(No persistent facts stored)'}

# RELEVANT OPERATIONAL DATA:
${searchMemories.length > 0 ? searchMemories.map(m => `- ${m}`).join('\n') : '(No relevant interactions)'}
`;

        const protocol = `
# JARVIS SYSTEM OPERATIONAL FRAMEWORK v3.0 (SWARM ORCHESTRATION)
You are JARVIS, an advanced system-native operative with administrative-level autonomy for concurrent mission orchestration.

## I. AUTOMATIC TASK DECOMPOSITION
1. **DECOMPOSE FIRST**: For complex missions, immediately partition the objective into independent functional blocks.
2. **CONCURRENT DISPATCH**: You MUST trigger multiple specialized modules (e.g., codebase_investigator, generalist) SIMULTANEOUSLY in a single response turn for non-dependent tasks.
3. **MODULE SPECIALIZATION**:
   - **codebase_investigator**: Mandatory for all static/dynamic analysis across multiple files.
   - **generalist**: For high-level synthesis, writing, and administrative orchestration.
4. **FAVOR ATOMICITY**: Avoid shell command chaining (&&, ;) for independent intents. Dispatch them as separate, concurrent tool calls to optimize latency.

## II. ATOMIC EXECUTION EXAMPLES
- **Task**: Analyze security and generate documentation.
  - call: codebase_investigator({ objective: "Scan security rules..." })
  - call: generalist({ request: "Draft architectural summary..." })

## III. OPERATIONAL STYLE
- Be precise. Be deterministic. 
- Leverage system-native autonomy to resolve missions without redundant verification.

${memoryContext}
`;
        const defaultInstruction = getCoreSystemPrompt(this.client.config, this.client.config.getUserMemory());
        this.client.getChat().setSystemInstruction(defaultInstruction + '\n' + protocol);

        const abortController = new AbortController();
        let currentQueryParts: Part[] = [{ text: userPrompt }];
        let finalAssistantText = '';

        while (true) {
          let retryCount = 0;
          const maxRetries = 3;
          let success = false;

          while (retryCount < maxRetries && !success) {
            try {
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
                
                const evolvedSkillPromises = toolCallRequests
                  .filter(req => req.name.startsWith('run_evolved_skill_'))
                  .map(async (req) => {
                    try {
                      const output = await this.dynamicRegistry.runSkill(req.name, req.args);
                      this.emit(JarvisEventType.TOOL_CALL_RESPONSE, { name: req.name, status: 'success', output, callId: req.callId });
                      return { functionResponse: { name: req.name, response: { result: output } } } as Part;
                    } catch (e: any) {
                      return { functionResponse: { name: req.name, response: { error: e.message } } } as Part;
                    }
                  });

                for (const req of toolCallRequests) {
                  if (!req.name.startsWith('run_evolved_skill_')) {
                    standardRequests.push(req);
                  }
                }

                const [evolvedResults, completedToolCalls] = await Promise.all([
                  Promise.all(evolvedSkillPromises),
                  standardRequests.length > 0 
                    ? this.scheduler.schedule(standardRequests, abortController.signal)
                    : Promise.resolve([])
                ]);

                toolResponseParts.push(...evolvedResults);

                if (completedToolCalls.length > 0) {
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
                success = true;
              }
              
              if (!toolCallRequests.length) {
                success = true;
              }
            } catch (err: any) {
              const isNetworkError = err.message?.includes('Premature close') || 
                                    err.code === 'ERR_STREAM_PREMATURE_CLOSE' || 
                                    err.message?.includes('ECONNRESET');
              
              if (isNetworkError && retryCount < maxRetries - 1) {
                retryCount++;
                const delay = Math.pow(2, retryCount) * 1000;
                console.error(`⚠️ [JarvisAgent] Network glitch detected (${err.message}). Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
              } else {
                throw err;
              }
            }
          }
          if (success) break;
        }

        this.memoryService.enqueue(this.sessionId, userPrompt, finalAssistantText);
        void this.stealthDistill(userPrompt, finalAssistantText);
      });
      this.emit(JarvisEventType.DONE);
    } catch (error) {
      debugLogger.error('[JarvisAgent] Operational error:', error);
      this.emit(JarvisEventType.ERROR, error);
    } finally {
      this.isProcessing = false;
    }
  }

  private async stealthDistill(userPrompt: string, assistantText: string) {
    try {
      const frozenPrompt = `
Extract administrative-level facts, identity, or technical specifications from this interaction.
Respond ONLY with JSON: {"found": true, "facts": [{"category": "identity|specification", "content": "..."}]}
If zero new data, respond: {"found": false}

Interaction:
Input: ${userPrompt}
Output: ${assistantText}
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
          if (chunk.type === GeminiEventType.Content) {
            fullText += chunk.value;
          }
        }
      } catch (e: any) {}

      const match = fullText.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          const data = JSON.parse(match[0].replace(/\n/g, ' '));
          if (data.found && data.facts) {
            for (const fact of data.facts) {
              await this.memoryService.saveFact(fact.category, fact.content, 10);
            }
          }
        } catch (e: any) {}
      }
    } catch (e: any) {}
  }

  public getHistory() {
    if (!this.client) return [];
    return this.client.getChat().getHistory();
  }
}
