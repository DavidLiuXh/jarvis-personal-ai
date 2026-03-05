/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { BaseLlmClient } from '../core/baseLlmClient.js';
export declare function ensureCorrectFileContent(content: string, baseLlmClient: BaseLlmClient, abortSignal: AbortSignal, disableLLMCorrection?: boolean, aggressiveUnescape?: boolean): Promise<string>;
export declare function correctStringEscaping(potentiallyProblematicString: string, baseLlmClient: BaseLlmClient, abortSignal: AbortSignal): Promise<string>;
/**
 * Unescapes a string that might have been overly escaped by an LLM.
 */
export declare function unescapeStringForGeminiBug(inputString: string): string;
export declare function resetEditCorrectorCaches_TEST_ONLY(): void;
