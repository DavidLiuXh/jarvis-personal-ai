/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Part } from "../../../gemini-cli/packages/core/src/index.js";
import { type MemoryService } from "./memory.js";

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
  /**
   * Force a specific model for this agent, overriding any routing decision.
   * Used by background task agents to bypass local model router.
   */
  forceModel?: string;
}

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

export type JarvisIncomingMessage =
  | JarvisChatMessage
  | JarvisPingMessage
  | JarvisRestoreMessage
  | JarvisConfirmationMessage
  | JarvisAgentInputMessage
  | JarvisAgentCancelMessage
  | JarvisBgCancelMessage;
