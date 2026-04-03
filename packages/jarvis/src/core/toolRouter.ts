/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  recordToolCallInteractions,
  type Part,
} from '../../../core/src/index.js';

export type ToolCallRequest = {
  name: string;
  args: Record<string, unknown>;
  callId: string;
};

export type ToolCallResponse = {
  name: string;
  status: string;
  output: unknown;
  callId: string;
};

export type MemoryServiceHandle = {
  saveFact: (category: string, content: string, importance: number) => Promise<void>;
  search: (query: string, limit: number) => Promise<string[]>;
};

export type DynamicRegistryHandle = {
  runSkill: (name: string, args: Record<string, unknown>) => Promise<string>;
};

export type SchedulerHandle = {
  schedule: (requests: ToolCallRequest[], signal: AbortSignal) => Promise<CompletedToolCall[]>;
};

type CompletedToolCall = {
  request: { name: string; callId: string };
  status: string;
  response: { responseParts?: Part[]; resultDisplay?: unknown };
};

type ClientHandle = {
  getChat: () => { getModel: () => string; recordCompletedToolCalls: (model: string, calls: CompletedToolCall[]) => void };
  getCurrentSequenceModel: () => string | null;
  config: { api?: { apiVersion?: string } };
};

const JARVIS_NATIVE_TOOLS = new Set(['save_memory', 'recall_memory']);

function isNativeTool(name: string): boolean {
  return name.startsWith('run_evolved_skill_') ||
    name.startsWith('task_') ||
    JARVIS_NATIVE_TOOLS.has(name);
}

type TaskCommandHandlerHandle = {
  handleTool: (action: string, args: Record<string, unknown>) => Promise<string>;
};

/**
 * Routes tool call requests to either Jarvis-native handlers or the Gemini
 * Scheduler, then assembles the response parts for the next LLM turn.
 */
export class ToolRouter {
  constructor(
    private memoryService: MemoryServiceHandle,
    private dynamicRegistry: DynamicRegistryHandle,
    private scheduler: SchedulerHandle,
    private client: ClientHandle,
    private taskCommandHandler?: TaskCommandHandlerHandle,
  ) {}

  async route(
    requests: ToolCallRequest[],
    signal: AbortSignal,
    onToolResponse: (response: ToolCallResponse) => void,
  ): Promise<Part[]> {
    const nativeRequests = requests.filter(r => isNativeTool(r.name));
    const standardRequests = requests.filter(r => !isNativeTool(r.name));

    const [directParts, completedCalls] = await Promise.all([
      Promise.all(nativeRequests.map(req => this.handleNative(req, onToolResponse))),
      standardRequests.length > 0
        ? this.scheduler.schedule(standardRequests, signal)
        : Promise.resolve([]),
    ]);

    const standardParts: Part[] = [];
    if (completedCalls.length > 0) {
      for (const completed of completedCalls) {
        if (completed.response.responseParts) {
          standardParts.push(...completed.response.responseParts);
        }
        onToolResponse({
          name: completed.request.name,
          status: completed.status,
          output: completed.response.resultDisplay,
          callId: completed.request.callId,
        });
      }
      try {
        const model = this.client.getCurrentSequenceModel() ?? this.client.getChat().getModel();
        this.client.getChat().recordCompletedToolCalls(model, completedCalls);
        await recordToolCallInteractions(this.client.config as Parameters<typeof recordToolCallInteractions>[0], completedCalls as Parameters<typeof recordToolCallInteractions>[1]);
      } catch (_e) {}
    }

    return [...directParts, ...standardParts];
  }

  private async handleNative(req: ToolCallRequest, onToolResponse: (r: ToolCallResponse) => void): Promise<Part> {
    try {
      let output = '';

      if (req.name.startsWith('run_evolved_skill_')) {
        output = await this.dynamicRegistry.runSkill(req.name, req.args);
      } else if (req.name === 'save_memory') {
        const fact = req.args.fact as string;
        await this.memoryService.saveFact('preference', fact, 10);
        output = `Integrated into structured core: ${fact}`;
        console.error(`🛡️ [Jarvis] Memory Redirected: ${fact}`);
      } else if (req.name === 'recall_memory') {
        const query = req.args.query as string;
        const limit = (req.args.limit as number) || 5;
        console.error(`🧠 [Jarvis] Active Recall initiated for: "${query}"`);
        const memories = await this.memoryService.search(query, limit);
        output = memories.length > 0
          ? `LONG-TERM MEMORIES FOUND:\n${memories.map(m => `- ${m}`).join('\n')}\n\nINSTRUCTION: Now synthesize this history into your final answer.`
          : `NO SPECIFIC MEMORIES FOUND for "${query}". Proceed with current knowledge.`;
      } else if (req.name.startsWith('task_')) {
        const action = req.name.slice('task_'.length);
        if (this.taskCommandHandler) {
          console.error(`📅 [Jarvis] Task tool invoked: ${req.name}`);
          output = await this.taskCommandHandler.handleTool(action, req.args);
        } else {
          output = '❌ Task management not available (TaskCommandHandler not initialized).';
        }
      }

      onToolResponse({ name: req.name, status: 'success', output, callId: req.callId });

      const responsePayload: unknown =
        this.client.config.api?.apiVersion === 'v1' ? output : { result: output };

      return { functionResponse: { name: req.name, response: responsePayload } } as Part;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { functionResponse: { name: req.name, response: { error: msg } } } as Part;
    }
  }
}
