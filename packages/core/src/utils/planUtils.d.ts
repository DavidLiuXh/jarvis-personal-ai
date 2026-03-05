/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Standard error messages for the plan approval workflow.
 * Shared between backend tools and CLI UI for consistency.
 */
export declare const PlanErrorMessages: {
    readonly PATH_ACCESS_DENIED: "Access denied: plan path must be within the designated plans directory.";
    readonly FILE_NOT_FOUND: (path: string) => string;
    readonly FILE_EMPTY: "Plan file is empty. You must write content to the plan file before requesting approval.";
    readonly READ_FAILURE: (detail: string) => string;
};
/**
 * Validates a plan file path for safety (traversal) and existence.
 * @param planPath The untrusted path to the plan file.
 * @param plansDir The authorized project plans directory.
 * @param targetDir The current working directory (project root).
 * @returns An error message if validation fails, or null if successful.
 */
export declare function validatePlanPath(planPath: string, plansDir: string, targetDir: string): Promise<string | null>;
/**
 * Validates that a plan file has non-empty content.
 * @param planPath The path to the plan file.
 * @returns An error message if the file is empty or unreadable, or null if successful.
 */
export declare function validatePlanContent(planPath: string): Promise<string | null>;
