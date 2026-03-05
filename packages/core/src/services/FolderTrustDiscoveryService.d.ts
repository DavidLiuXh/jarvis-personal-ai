/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
export interface FolderDiscoveryResults {
    commands: string[];
    mcps: string[];
    hooks: string[];
    skills: string[];
    settings: string[];
    securityWarnings: string[];
    discoveryErrors: string[];
}
/**
 * A safe, read-only service to discover local configurations in a folder
 * before it is trusted.
 */
export declare class FolderTrustDiscoveryService {
    /**
     * Discovers configurations in the given workspace directory.
     * @param workspaceDir The directory to scan.
     * @returns A summary of discovered configurations.
     */
    static discover(workspaceDir: string): Promise<FolderDiscoveryResults>;
    private static discoverCommands;
    private static discoverSkills;
    private static discoverSettings;
    private static collectSecurityWarnings;
    private static isRecord;
    private static exists;
}
