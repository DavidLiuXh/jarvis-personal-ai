/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
export interface RegistryData {
    projects: Record<string, string>;
}
/**
 * Manages a mapping between absolute project paths and short, human-readable identifiers.
 * This helps reduce context bloat and makes temporary directories easier to work with.
 */
export declare class ProjectRegistry {
    private readonly registryPath;
    private readonly baseDirs;
    private data;
    private initPromise;
    constructor(registryPath: string, baseDirs?: string[]);
    /**
     * Initializes the registry by loading data from disk.
     */
    initialize(): Promise<void>;
    private loadData;
    private normalizePath;
    private save;
    /**
     * Returns a short identifier for the given project path.
     * If the project is not already in the registry, a new identifier is generated and saved.
     */
    getShortId(projectPath: string): Promise<string>;
    private verifySlugOwnership;
    private findExistingSlugForPath;
    private claimNewSlug;
    private ensureOwnershipMarkers;
    private slugify;
}
