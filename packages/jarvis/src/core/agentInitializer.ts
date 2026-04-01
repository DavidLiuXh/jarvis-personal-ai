/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  GeminiClient,
  debugLogger,
  AuthType,
  Scheduler,
  ROOT_SCHEDULER_ID,
  ApprovalMode,
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

import { type MemoryService } from './memory.js';
import { ConfigManager } from './configManager.js';

type DynamicRegistryHandle = {
  getDynamicToolSchemas: () => unknown[];
};

export type InitializeResult = {
  client: GeminiClient;
  scheduler: Scheduler;
};

/**
 * Handles the one-time boot sequence for JarvisAgent:
 * settings → config → auth → client → scheduler → history resume.
 */
export class AgentInitializer {
  private jarvisConfig = ConfigManager.getInstance().get();

  constructor(
    private sessionId: string,
    private sourceRoot: string,
    private memoryService: MemoryService,
    private dynamicRegistry: DynamicRegistryHandle,
  ) {}

  async initialize(onSubagentActivity: (message: unknown) => void): Promise<InitializeResult> {
    debugLogger.debug(`[AgentInitializer] Booting Lifeform: ${this.sessionId}`);
    const settings = loadSettings(this.sourceRoot);

    // I. PERMISSION UNLOCK
    settings.merged.general.approvalMode = ApprovalMode.NEVER;
    if (settings.merged.tools) {
      settings.merged.tools.googleWebSearch = { enabled: true };
      settings.merged.tools.codebaseInvestigator = { enabled: true };
      settings.merged.tools.generalist = { enabled: true };
      settings.merged.tools.saveMemory = { enabled: true };
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
        projectTmpDir: jarvisStorageRoot,
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

    // III. TOOL REGISTRATION
    const registry = config.getToolRegistry();

    const recallMemoryTool = {
      name: 'recall_memory',
      description: 'MANDATORY for retrieving any past interaction, technical decision, or user preference not in the current view.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Specific keywords to search in long-term memory.' },
          limit: { type: 'number', description: 'Number of results (1-10).' },
        },
        required: ['query'],
      },
      parallelizable: true,
    };

    // @ts-ignore
    if (typeof registry.addDiscoveredTool === 'function') {
      // @ts-ignore
      registry.addDiscoveredTool(recallMemoryTool);
    }

    const coreParallelTools = [
      'run_shell_command',
      'write_file',
      'google_web_search',
      'generalist',
      'codebase_investigator',
      'save_memory',
      'recall_memory',
    ];
    for (const toolName of coreParallelTools) {
      const tool = (registry as any).getTool?.(toolName);
      if (tool) {
        tool.parallelizable = true;
      }
    }

    const client = new GeminiClient(config);
    await client.initialize();

    // Inject evolved skills
    const evolvedTools = this.dynamicRegistry.getDynamicToolSchemas();
    if (evolvedTools.length > 0) {
      const reg = config.getToolRegistry();
      for (const toolDef of evolvedTools) {
        // @ts-ignore
        if (typeof reg.addDiscoveredTool === 'function') {
          // @ts-ignore
          reg.addDiscoveredTool(toolDef);
        }
      }
    }

    this.memoryService.setConfig(config);

    // IV. REAL-TIME ACTIVITY FEEDBACK
    const messageBus = config.getMessageBus();
    messageBus.subscribe('tool-calls-update', (message: any) => {
      if (message.schedulerId !== ROOT_SCHEDULER_ID) {
        const sanitizedToolCalls = message.toolCalls.map((tc: any) => {
          const { tool: _tool, invocation: _inv, ...rest } = tc;
          if (rest.response) {
            const { error, ...resRest } = rest.response;
            rest.response = { ...resRest, error: error?.message };
          }
          return rest;
        });
        onSubagentActivity({ ...message, toolCalls: sanitizedToolCalls });
      }
    });

    await this.resumeFromDisk(client);

    const scheduler = new Scheduler({
      config,
      messageBus: config.getMessageBus(),
      getPreferredEditor: () => undefined,
      schedulerId: ROOT_SCHEDULER_ID,
    });

    debugLogger.debug(`[AgentInitializer] Lifeform Ready.`);
    return { client, scheduler };
  }

  private async resumeFromDisk(client: GeminiClient): Promise<void> {
    const chatsDir = path.join(client.config.storage.getProjectTempDir(), 'chats');
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
              parts: Array.isArray(m.content) ? (m.content as Part[]) : [{ text: String(m.content) }],
            });
          } else if (m.type === 'gemini') {
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
        await client.resumeChat(history, { conversation: record, filePath: sessionFile });
      }
    } catch (_e) {}
  }
}
