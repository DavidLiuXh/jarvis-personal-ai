/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
export interface HierarchicalMemory {
    global?: string;
    extension?: string;
    project?: string;
}
/**
 * Flattens hierarchical memory into a single string for display or legacy use.
 */
export declare function flattenMemory(memory?: string | HierarchicalMemory): string;
