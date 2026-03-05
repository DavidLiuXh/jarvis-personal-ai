/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Migration utility to move data from old hash-based directories to new slug-based directories.
 */
export declare class StorageMigration {
    /**
     * Migrates a directory from an old path to a new path if the old one exists and the new one doesn't.
     * @param oldPath The old directory path (hash-based).
     * @param newPath The new directory path (slug-based).
     */
    static migrateDirectory(oldPath: string, newPath: string): Promise<void>;
}
