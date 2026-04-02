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
  LlmRole,
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
import { buildHistoryFromMessages } from './resumeFromDisk.js';
import {
  loadSummaryState,
  saveSummaryState,
  buildIncrementalSummary,
  buildStructuredContext,
  mergeStructuredContext,
  buildHistoryWithSummary,
  getNewOrUpdatedFiles,
  type SessionMessage,
  type StructuredContext,
  EMPTY_STRUCTURED_CONTEXT,
} from './sessionSummarizer.js';

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

    // Build generateText using CLI-auth ContentGenerator (same pattern as agent.ts)
    const generateText = async (prompt: string): Promise<string> => {
      const generator = client.config.getContentGenerator();
      const response = await generator.generateContent(
        { model: this.jarvisConfig.models.distillation, contents: [{ role: 'user', parts: [{ text: prompt }] }] },
        `summarize-${Date.now()}`,
        LlmRole.UTILITY_SUMMARIZER,
      );
      return (response as any).candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    };

    await this.resumeFromDisk(client, generateText);

    const scheduler = new Scheduler({
      config,
      messageBus: config.getMessageBus(),
      getPreferredEditor: () => undefined,
      schedulerId: ROOT_SCHEDULER_ID,
    });

    debugLogger.debug(`[AgentInitializer] Lifeform Ready.`);
    return { client, scheduler };
  }

  private async resumeFromDisk(
    client: GeminiClient,
    generateText?: (prompt: string) => Promise<string>,
  ): Promise<void> {
    if (!this.jarvisConfig.session?.resumeOnStart) {
      debugLogger.debug('[AgentInitializer] resumeOnStart=false, skipping history restore.');
      return;
    }

    const chatsDir = path.join(client.config.storage.getProjectTempDir(), 'chats');
    const memoryDir = path.join(os.homedir(), '.gemini-jarvis', 'memory');
    const recentTurns = this.jarvisConfig.session?.recentTurnsOnResume ?? 20;

    try {
      if (!fs.existsSync(chatsDir)) return;

      // 1. Collect all session files sorted by mtime (oldest first)
      const allFiles = fs.readdirSync(chatsDir)
        .filter(f => f.endsWith('.json'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(chatsDir, f)).mtimeMs }))
        .sort((a, b) => a.mtime - b.mtime);

      if (allFiles.length === 0) return;

      // 2. Load existing summary state
      const existingState = loadSummaryState(memoryDir);

      // 3. Find new or updated files using mtime comparison
      const newOrUpdatedFiles = getNewOrUpdatedFiles(allFiles, existingState);

      // 4. Collect messages from new/updated files
      const newMessages: SessionMessage[] = [];
      for (const file of newOrUpdatedFiles) {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(chatsDir, file.name), 'utf8'));
          newMessages.push(...(raw.messages ?? []));
        } catch (_e) {}
      }

      // 5. Update structured context + summary incrementally
      let summary = existingState?.summary ?? '';
      let structuredContext: StructuredContext = existingState?.structuredContext ?? { ...EMPTY_STRUCTURED_CONTEXT };
      let contextUpdated = false;

      if (newMessages.length > 0 && generateText) {
        console.error(`🧠 [Jarvis] Updating session context (${newOrUpdatedFiles.length} new/updated files, ${newMessages.length} messages)...`);
        try {
          // Pass existing structuredContext so LLM can merge incrementally
          const incomingCtx = await buildStructuredContext(
            newMessages, structuredContext, generateText, { maxRetries: 3, retryDelayMs: 2000 }
          );
          const merged = mergeStructuredContext(structuredContext, incomingCtx);

          // Also update plain-text summary as fallback
          const newSummary = await buildIncrementalSummary(
            newMessages, summary || null, generateText, { maxRetries: 3, retryDelayMs: 2000 }
          );

          // Only persist if we got meaningful content
          const hasContent = merged.entities.length > 0 || merged.behaviors.length > 0 ||
            merged.decisions.length > 0 || newSummary.trim().length > 0;

          if (hasContent) {
            structuredContext = merged;
            summary = newSummary;
            const processedFileMtimes: Record<string, number> = {};
            for (const f of allFiles) processedFileMtimes[f.name] = f.mtime;
            saveSummaryState(memoryDir, { summary, structuredContext, processedFileMtimes, updatedAt: Date.now() });
            contextUpdated = true;
            console.error(`✅ [Jarvis] Session context updated (${structuredContext.entities.length} entities, ${structuredContext.behaviors.length} behaviors, ${structuredContext.decisions.length} decisions).`);
          } else {
            console.error(`⚠️ [Jarvis] Context extraction returned empty result — not persisting. Will retry next startup.`);
          }
        } catch (e: any) {
          console.error(`⚠️ [Jarvis] Context update failed, using existing: ${e.message}`);
        }
      } else if (newMessages.length > 0 && !generateText) {
        debugLogger.debug('[AgentInitializer] generateText unavailable, skipping context update.');
      } else {
        debugLogger.debug('[AgentInitializer] No new session content, using existing context.');
      }

      // If we have no structured context AND no summary (first run failure), log a warning
      const hasAnyContext = structuredContext.entities.length > 0 || structuredContext.behaviors.length > 0 || summary.trim().length > 0;
      if (!hasAnyContext && !contextUpdated) {
        console.error(`⚠️ [Jarvis] No context available for injection — starting fresh. History will be limited to recent ${recentTurns} turns.`);
      }

      // 6. Take the most recent N raw messages across ALL files for the recent turns
      const allMessages: SessionMessage[] = [];
      for (const file of allFiles) {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(chatsDir, file.name), 'utf8'));
          allMessages.push(...(raw.messages ?? []));
        } catch (_e) {}
      }
      const recentMessages = allMessages.slice(-recentTurns);

      // 7. Build history: structured context prefix + recent raw turns
      const history = buildHistoryWithSummary(summary, recentMessages, structuredContext);

      // 8. Use the latest session file as the active recording target
      const latestFile = allFiles[allFiles.length - 1];
      const latestRecord = JSON.parse(
        fs.readFileSync(path.join(chatsDir, latestFile.name), 'utf8')
      ) as ConversationRecord;

      await client.resumeChat(history, { conversation: latestRecord, filePath: path.join(chatsDir, latestFile.name) });

      // 9. Stats log
      const totalMsgs = allMessages.length;
      const userTurns = allMessages.filter(m => m.type === 'user').length;
      const modelTurns = allMessages.filter(m => m.type === 'gemini').length;
      const toolCalls = allMessages.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0);
      // timestamp may be ISO string or number — normalise to ms
      const timestamps = allMessages
        .map(m => m.timestamp)
        .filter(Boolean)
        .map(t => typeof t === 'string' ? new Date(t as string).getTime() : Number(t))
        .filter(t => !isNaN(t));
      const earliest = timestamps.length ? new Date(Math.min(...timestamps)).toLocaleString() : 'unknown';
      const latest = timestamps.length ? new Date(Math.max(...timestamps)).toLocaleString() : 'unknown';

      console.error(
        `📂 [Jarvis] Session restored: ${allFiles.length} session files, ${totalMsgs} total messages ` +
        `(${userTurns} user / ${modelTurns} model / ${toolCalls} tool calls) | ` +
        `${earliest} → ${latest} | injected: summary + ${recentMessages.length} recent turns`
      );
    } catch (e: any) {
      console.error(`⚠️ [AgentInitializer] resumeFromDisk failed: ${e.message}`);
    }
  }
}
