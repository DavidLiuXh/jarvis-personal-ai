/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { JarvisAgent } from './agent.js';
import { MemoryService } from './memory.js';
import { debugLogger } from '../../../core/src/index.js';
import { ConfigManager } from './configManager.js';

export class JarvisManager {
  private static instance: JarvisManager;
  private agents: Map<string, JarvisAgent> = new Map();
  private sourceRoot: string;
  private memoryService: MemoryService;

  private constructor(sourceRoot: string) {
    this.sourceRoot = sourceRoot;
    this.memoryService = new MemoryService(sourceRoot);
  }

  public static getInstance(sourceRoot: string): JarvisManager {
    if (!JarvisManager.instance) {
      JarvisManager.instance = new JarvisManager(sourceRoot);
    }
    return JarvisManager.instance;
  }

  public getMemoryService(): MemoryService {
    return this.memoryService;
  }

  /**
   * Retrieves or creates a JarvisAgent.
   * Supports Global Session Mode for cross-channel synchronization.
   */
  public async getAgent(sessionId: string): Promise<JarvisAgent> {
    const config = ConfigManager.getInstance().get();
    
    // 🌍 GLOBAL SYNC LOGIC:
    // If enabled, all requests resolve to the same master agent instance.
    const effectiveId = config.session.useGlobalSession 
      ? config.session.globalSessionId 
      : sessionId;

    if (this.agents.has(effectiveId)) {
      return this.agents.get(effectiveId)!;
    }

    debugLogger.debug(`[JarvisManager] Creating agent for effective session: ${effectiveId} (Requested: ${sessionId})`);
    
    const agent = new JarvisAgent({
      sessionId: effectiveId,
      cwd: this.sourceRoot,
      memoryService: this.memoryService
    });

    this.agents.set(effectiveId, agent);
    return agent;
  }

  public async cleanup() {
    debugLogger.debug(`[JarvisManager] Cleaning up ${this.agents.size} agents...`);
    for (const [id, agent] of this.agents) {
      agent.removeAllListeners();
    }
    this.agents.clear();
  }
}
