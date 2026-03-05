/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { type Part } from '@google/genai';
import { type ConversationRecord } from '../services/chatRecordingService.js';
/**
 * Converts session/conversation data into Gemini client history formats.
 */
export declare function convertSessionToClientHistory(messages: ConversationRecord['messages']): Array<{
    role: 'user' | 'model';
    parts: Part[];
}>;
