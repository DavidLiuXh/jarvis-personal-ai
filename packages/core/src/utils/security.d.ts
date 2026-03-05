/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
export interface SecurityCheckResult {
    secure: boolean;
    reason?: string;
}
/**
 * Verifies if a directory is secure (owned by root and not writable by others).
 *
 * @param dirPath The path to the directory to check.
 * @returns A promise that resolves to a SecurityCheckResult.
 */
export declare function isDirectorySecure(dirPath: string): Promise<SecurityCheckResult>;
