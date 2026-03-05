/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
export declare enum IntegrityStatus {
    MATCH = "MATCH",
    MISMATCH = "MISMATCH",
    NEW = "NEW"
}
export interface IntegrityResult {
    status: IntegrityStatus;
    hash: string;
    fileCount: number;
}
export declare class PolicyIntegrityManager {
    /**
     * Checks the integrity of policies in a given directory against the stored hash.
     *
     * @param scope The scope of the policy (e.g., 'project', 'user').
     * @param identifier A unique identifier for the policy scope (e.g., project path).
     * @param policyDir The directory containing the policy files.
     * @returns IntegrityResult indicating if the current policies match the stored hash.
     */
    checkIntegrity(scope: string, identifier: string, policyDir: string): Promise<IntegrityResult>;
    /**
     * Accepts and persists the current integrity hash for a given policy scope.
     *
     * @param scope The scope of the policy.
     * @param identifier A unique identifier for the policy scope (e.g., project path).
     * @param hash The hash to persist.
     */
    acceptIntegrity(scope: string, identifier: string, hash: string): Promise<void>;
    /**
     * Calculates a SHA-256 hash of all policy files in the directory.
     * The hash includes the relative file path and content to detect renames and modifications.
     *
     * @param policyDir The directory containing the policy files.
     * @returns The calculated hash and file count
     */
    private static calculateIntegrityHash;
    private getIntegrityKey;
    private loadIntegrityData;
    private saveIntegrityData;
}
