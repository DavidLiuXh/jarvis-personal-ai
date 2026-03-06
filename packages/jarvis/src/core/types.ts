/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Part } from '../../../core/src/index.js';

export enum JarvisEventType {
  CONTENT = 'content',
  THOUGHT = 'thought',
  TOOL_CALL_REQUEST = 'tool_call_request',
  TOOL_CALL_RESPONSE = 'tool_call_response',
  DONE = 'done',
  ERROR = 'error'
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
}

export interface JarvisChatMessage {
  type: 'chat';
  payload: string;
  sessionId?: string;
}

export interface JarvisPingMessage {
  type: 'ping';
}

export interface JarvisRestoreMessage {
  type: 'restore';
  sessionId: string;
}

export type JarvisIncomingMessage =
  | JarvisChatMessage
  | JarvisPingMessage
  | JarvisRestoreMessage;
