/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { type ToolFamily } from './types.js';
/**
 * Resolves the ToolFamily for a given model ID.
 * Defaults to 'default-legacy' if the model is not recognized or not provided.
 *
 * @param modelId The model identifier (e.g., 'gemini-2.5-pro', 'gemini-3-flash-preview')
 * @returns The resolved ToolFamily
 */
export declare function getToolFamily(modelId?: string): ToolFamily;
