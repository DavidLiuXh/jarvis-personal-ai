/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { DiffStat, FileDiff } from '../tools/tools.js';
import type { ToolCallRecord } from '../services/chatRecordingService.js';
/**
 * Safely extracts the FileDiff object from a tool call's resultDisplay.
 * This helper performs runtime checks to ensure the object conforms to the FileDiff structure.
 * @param resultDisplay The resultDisplay property of a ToolCallRecord.
 * @returns The FileDiff object if found and valid, otherwise undefined.
 */
export declare function getFileDiffFromResultDisplay(resultDisplay: ToolCallRecord['resultDisplay']): FileDiff | undefined;
export declare function computeModelAddedAndRemovedLines(stats: DiffStat | undefined): {
    addedLines: number;
    removedLines: number;
};
