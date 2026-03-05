/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { ApprovalMode } from '../policy/types.js';
/**
 * Returns a human-readable description for an approval mode.
 */
export declare function getApprovalModeDescription(mode: ApprovalMode): string;
/**
 * Generates a consistent message for plan mode transitions.
 */
export declare function getPlanModeExitMessage(newMode: ApprovalMode, isManual?: boolean): string;
