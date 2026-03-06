/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { JarvisAgent } from './agent.js';
import { debugLogger } from '../../../core/src/index.js';

export class JarvisManager {
  private static instance: JarvisManager;
  private agents: Map<string, JarvisAgent> = new Map();
  private cwd: string;

  private constructor(cwd: string = process.cwd()) {
    this.cwd = cwd;
  }

  public static getInstance(cwd?: string): JarvisManager {
    if (!JarvisManager.instance) {
      JarvisManager.instance = new JarvisManager(cwd);
    }
    return JarvisManager.instance;
  }

  public async getAgent(sessionId: string): Promise<JarvisAgent> {
    let agent = this.agents.get(sessionId);
    if (!agent) {
      debugLogger.debug(`[JarvisManager] Creating new agent for session: ${sessionId}`);
      agent = new JarvisAgent({
        sessionId,
        cwd: this.cwd
      });
      // Initializing can be done lazily on first message or here
      await agent.initialize();
      this.agents.set(sessionId, agent);
    }
    return agent;
  }

  public removeAgent(sessionId: string) {
    const agent = this.agents.get(sessionId);
    if (agent) {
      agent.removeAllListeners();
      this.agents.delete(sessionId);
      debugLogger.debug(`[JarvisManager] Removed agent: ${sessionId}`);
    }
  }

  public async cleanup() {
    debugLogger.debug(`[JarvisManager] Cleaning up ${this.agents.size} agents...`);
    for (const [id, agent] of this.agents) {
      agent.removeAllListeners();
    }
    this.agents.clear();
  }
}
