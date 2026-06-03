/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type MemoryService } from "./memory.js";
import type { EventEmitter } from "node:events";
import type { AgentManager } from "./agentManager.js";
import type { BackgroundTaskRunner } from "./backgroundTaskRunner.js";
import type { ChannelRegistry } from "./channelRegistry.js";
import type { SkillInfo } from "./systemPromptBuilder.js";
import type { TaskCommandHandler } from "./taskCommandHandler.js";
import type { SkillCommandHandler } from "./skillCommandHandler.js";
import type { RuntimeConversationContent } from "./runtimeTypes.js";

export enum JarvisEventType {
  CONTENT = "content",
  THOUGHT = "thought",
  TOOL_CALL_REQUEST = "tool_call_request",
  TOOL_CALL_RESPONSE = "tool_call_response",
  SUBAGENT_ACTIVITY = "subagent_activity",
  DONE = "done",
  ERROR = "error",
}

export interface JarvisEvent {
  type: JarvisEventType;
  value: any;
  sessionId: string;
  timestamp: number;
}

export interface JarvisAgentOptions {
  sessionId: string;
  cwd: string;
  memoryService: MemoryService;
  /** Skip session history restore — used for background task agents */
  skipResume?: boolean;
  /**
   * Lightweight mode for ephemeral agents (background tasks).
   * Skips: BackgroundDistiller, summarizerGenerateText, EntityExtractor
   * trigger (via setGenerateText), autoBackfill/waitForBackfill.
   * These are expensive and irrelevant for one-shot background tasks.
   */
  lightweight?: boolean;
}

export type JarvisAgentLike = EventEmitter & {
  initialize(): Promise<void>;
  processMessage(
    userPrompt: string,
    imageAttachment?: { mimeType: string; data: Buffer },
  ): Promise<void>;
  getHistory(): readonly RuntimeConversationContent[];
  setTaskCommandHandler(handler: TaskCommandHandler): void;
  setChannelRegistry(registry: ChannelRegistry): void;
  setAvailableSkills(skills: SkillInfo[]): void;
  setSkillCommandHandler(handler: SkillCommandHandler): void;
  setAgentManager(manager: AgentManager): void;
  setBackgroundTaskRunner(runner: BackgroundTaskRunner): void;
  triggerSkillExtraction(): Promise<void>;
  setAskUserHandler(
    ws: { readyState: number; send: (data: string) => void },
    ownerId: string,
  ): void;
  clearAskUserHandlerIfOwner(ownerId: string): void;
  rejectPendingAskUsersForOwner(ownerId: string): void;
  provideAskUserResponse(
    id: string,
    answers: Record<string, string>,
    cancelled?: boolean,
  ): void;
  provideConfirmationResponse(id: string, decision: "allow" | "deny"): void;
};

export interface JarvisChatMessage {
  type: "chat";
  payload: string;
  sessionId?: string;
}

export interface JarvisPingMessage {
  type: "ping";
}

export interface JarvisRestoreMessage {
  type: "restore";
  sessionId: string;
}

export interface JarvisConfirmationMessage {
  type: "confirmation";
  id: string;
  decision: "allow" | "deny";
  sessionId?: string;
}

/** User sends input to a paused agent task (INPUT_REQUIRED state) */
export interface JarvisAgentInputMessage {
  type: "agent_input";
  taskId: string;
  value: string;
  sessionId?: string;
}

/** User cancels a running agent task */
export interface JarvisAgentCancelMessage {
  type: "agent_cancel";
  taskId: string;
  sessionId?: string;
}

/** Cancel a running background task */
export interface JarvisBgCancelMessage {
  type: "bg_cancel";
  taskId: string;
  sessionId?: string;
}

/** User submits answers to an ask_user_request form */
export interface JarvisAskUserResponseMessage {
  type: "ask_user_response";
  id: string;
  answers: Record<string, string>;
  /** true when the user dismissed the form without answering */
  cancelled?: boolean;
  sessionId?: string;
}

export type JarvisIncomingMessage =
  | JarvisChatMessage
  | JarvisPingMessage
  | JarvisRestoreMessage
  | JarvisConfirmationMessage
  | JarvisAgentInputMessage
  | JarvisAgentCancelMessage
  | JarvisBgCancelMessage
  | JarvisAskUserResponseMessage;
