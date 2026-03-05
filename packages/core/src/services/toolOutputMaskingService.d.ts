/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
export declare const DEFAULT_TOOL_PROTECTION_THRESHOLD = 50000;
export declare const DEFAULT_MIN_PRUNABLE_TOKENS_THRESHOLD = 30000;
export declare const DEFAULT_PROTECT_LATEST_TURN = true;
export declare const MASKING_INDICATOR_TAG = "tool_output_masked";
export declare const TOOL_OUTPUTS_DIR = "tool-outputs";
export interface MaskingResult {
    newHistory: Content[];
    maskedCount: number;
    tokensSaved: number;
}
/**
 * Service to manage context window efficiency by masking bulky tool outputs (Tool Output Masking).
 *
 * It implements a "Hybrid Backward Scanned FIFO" algorithm to balance context relevance with
 * token savings:
 * 1. **Protection Window**: Protects the newest `toolProtectionThreshold` (default 50k) tool tokens
 *    from pruning. Optionally skips the entire latest conversation turn to ensure full context for
 *    the model's next response.
 * 2. **Global Aggregation**: Scans backwards past the protection window to identify all remaining
 *    tool outputs that haven't been masked yet.
 * 3. **Batch Trigger**: Trigger masking only if the total prunable tokens exceed
 *    `minPrunableTokensThreshold` (default 30k).
 *
 * @remarks
 * Effectively, this means masking only starts once the conversation contains approximately 80k
 * tokens of prunable tool outputs (50k protected + 30k prunable buffer). Small tool outputs
 * are preserved until they collectively reach the threshold.
 */
export declare class ToolOutputMaskingService {
    mask(history: Content[], config: Config): Promise<MaskingResult>;
    private getToolOutputContent;
    private isAlreadyMasked;
    private formatShellPreview;
    private formatSimplePreview;
    private formatMaskedSnippet;
}
