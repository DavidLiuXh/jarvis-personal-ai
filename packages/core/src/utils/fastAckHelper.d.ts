/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { BaseLlmClient } from '../core/baseLlmClient.js';
import type { ModelConfigKey } from '../services/modelConfigService.js';
export declare const DEFAULT_FAST_ACK_MODEL_CONFIG_KEY: ModelConfigKey;
export declare const DEFAULT_MAX_INPUT_CHARS = 1200;
export declare const DEFAULT_MAX_OUTPUT_CHARS = 180;
/**
 * Normalizes whitespace in a string and trims it.
 */
export declare function normalizeSpace(text: string): string;
export declare const USER_STEERING_INSTRUCTION: string;
export declare function buildUserSteeringHintPrompt(hintText: string): string;
export declare function formatUserHintsForModel(hints: string[]): string | null;
export declare function generateSteeringAckMessage(llmClient: BaseLlmClient, hintText: string): Promise<string>;
export interface GenerateFastAckTextOptions {
    instruction: string;
    input: string;
    fallbackText: string;
    abortSignal: AbortSignal;
    promptId: string;
    modelConfigKey?: ModelConfigKey;
    maxInputChars?: number;
    maxOutputChars?: number;
}
export declare function truncateFastAckInput(input: string, maxInputChars?: number): string;
export declare function generateFastAckText(llmClient: BaseLlmClient, options: GenerateFastAckTextOptions): Promise<string>;
