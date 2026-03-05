/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import type { GeminiChat } from '../core/geminiChat.js';
import { type ChatCompressionInfo } from '../core/turn.js';
/**
 * Returns the index of the oldest item to keep when compressing. May return
 * contents.length which indicates that everything should be compressed.
 *
 * Exported for testing purposes.
 */
export declare function findCompressSplitPoint(contents: Content[], fraction: number): number;
export declare function modelStringToModelConfigAlias(model: string): string;
export declare class ChatCompressionService {
    compress(chat: GeminiChat, promptId: string, force: boolean, model: string, config: Config, hasFailedCompressionAttempt: boolean, abortSignal?: AbortSignal): Promise<{
        newHistory: Content[] | null;
        info: ChatCompressionInfo;
    }>;
}
