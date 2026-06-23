/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { MemoryService } from "./memory.js";
import { runtimeLogger as debugLogger } from "./runtimeLogger.js";
import { ConfigManager } from "./configManager.js";
import { type AgentManager } from "./agentManager.js";
import { type BackgroundTaskRunner } from "./backgroundTaskRunner.js";
import { type ChannelRegistry } from "./channelRegistry.js";
import { type TaskCommandHandler } from "./taskCommandHandler.js";
import { StandaloneJarvisAgent } from "./standaloneAgent.js";
import type { JarvisAgentLike } from "./types.js";

export class JarvisManager {
  private static instance: JarvisManager;
  private agents: Map<string, JarvisAgentLike> = new Map();
  private sourceRoot: string;
  private memoryService: MemoryService;
  private agentManager: AgentManager | null = null;
  private backgroundTaskRunner: BackgroundTaskRunner | null = null;
  private channelRegistry: ChannelRegistry | null = null;
  private taskCommandHandler: TaskCommandHandler | null = null;

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

  /** Set once at startup so every newly created agent gets it immediately. */
  public setAgentManager(manager: AgentManager): void {
    this.agentManager = manager;
    for (const agent of this.agents.values()) {
      agent.setAgentManager(manager);
    }
  }

  public setBackgroundTaskRunner(runner: BackgroundTaskRunner): void {
    this.backgroundTaskRunner = runner;
    for (const agent of this.agents.values()) {
      agent.setBackgroundTaskRunner(runner);
    }
  }

  public setChannelRegistry(registry: ChannelRegistry): void {
    this.channelRegistry = registry;
    for (const agent of this.agents.values()) {
      agent.setChannelRegistry(registry);
    }
  }

  public setTaskCommandHandler(handler: TaskCommandHandler): void {
    this.taskCommandHandler = handler;
    for (const agent of this.agents.values()) {
      agent.setTaskCommandHandler(handler);
    }
  }

  public getMemoryService(): MemoryService {
    return this.memoryService;
  }

  /**
   * Retrieves or creates a JarvisAgent.
   * Supports Global Session Mode for cross-channel synchronization.
   */
  public async getAgent(sessionId: string): Promise<JarvisAgentLike> {
    const config = ConfigManager.getInstance().get();

    // 🌍 GLOBAL SYNC LOGIC:
    // If enabled, all requests resolve to the same master agent instance.
    const effectiveId = config.session.useGlobalSession
      ? config.session.globalSessionId
      : sessionId;

    if (this.agents.has(effectiveId)) {
      return this.agents.get(effectiveId)!;
    }

    debugLogger.debug(
      `[JarvisManager] Creating agent for effective session: ${effectiveId} (Requested: ${sessionId})`,
    );

    const agent =
      (config.llmBackend?.provider ?? "gemini") !== "gemini"
        ? new StandaloneJarvisAgent({
            sessionId: effectiveId,
            cwd: this.sourceRoot,
            memoryService: this.memoryService,
          })
        : await this.createGeminiCompatibilityAgent(effectiveId);

    if (this.agentManager) agent.setAgentManager(this.agentManager);
    if (this.backgroundTaskRunner)
      agent.setBackgroundTaskRunner(this.backgroundTaskRunner);
    if (this.channelRegistry) agent.setChannelRegistry(this.channelRegistry);
    if (this.taskCommandHandler)
      agent.setTaskCommandHandler(this.taskCommandHandler);

    this.agents.set(effectiveId, agent);
    return agent;
  }

  private async createGeminiCompatibilityAgent(
    sessionId: string,
  ): Promise<JarvisAgentLike> {
    const { JarvisAgent } = await import("./geminiAgent.js");
    return new JarvisAgent({
      sessionId,
      cwd: this.sourceRoot,
      memoryService: this.memoryService,
    });
  }

  public async cleanup() {
    debugLogger.debug(
      `[JarvisManager] Cleaning up ${this.agents.size} agents...`,
    );
    for (const [id, agent] of this.agents) {
      agent.removeAllListeners();
    }
    this.agents.clear();
  }
}
