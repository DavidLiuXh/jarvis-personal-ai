/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
export declare const OAUTH_FILE = "oauth_creds.json";
export declare const AUTO_SAVED_POLICY_FILENAME = "auto-saved.toml";
export declare class Storage {
    private readonly targetDir;
    private readonly sessionId;
    private projectIdentifier;
    private initPromise;
    private customPlansDir;
    constructor(targetDir: string, sessionId?: string);
    setCustomPlansDir(dir: string | undefined): void;
    static getGlobalGeminiDir(): string;
    static getGlobalAgentsDir(): string;
    static getMcpOAuthTokensPath(): string;
    static getGlobalSettingsPath(): string;
    static getInstallationIdPath(): string;
    static getGoogleAccountsPath(): string;
    static getUserCommandsDir(): string;
    static getUserSkillsDir(): string;
    static getUserAgentSkillsDir(): string;
    static getGlobalMemoryFilePath(): string;
    static getUserPoliciesDir(): string;
    static getUserAgentsDir(): string;
    static getAcknowledgedAgentsPath(): string;
    static getPolicyIntegrityStoragePath(): string;
    private static getSystemConfigDir;
    static getSystemSettingsPath(): string;
    static getSystemPoliciesDir(): string;
    static getGlobalTempDir(): string;
    static getGlobalBinDir(): string;
    getGeminiDir(): string;
    /**
     * Checks if the current workspace storage location is the same as the global/user storage location.
     * This handles symlinks and platform-specific path normalization.
     */
    isWorkspaceHomeDir(): boolean;
    getAgentsDir(): string;
    getProjectTempDir(): string;
    getWorkspacePoliciesDir(): string;
    getAutoSavedPolicyPath(): string;
    ensureProjectTempDirExists(): void;
    static getOAuthCredsPath(): string;
    getProjectRoot(): string;
    private getFilePathHash;
    private getProjectIdentifier;
    /**
     * Initializes storage by setting up the project registry and performing migrations.
     */
    initialize(): Promise<void>;
    /**
     * Performs migration of legacy hash-based directories to the new slug-based format.
     * This is called internally by initialize().
     */
    private performMigration;
    getHistoryDir(): string;
    getWorkspaceSettingsPath(): string;
    getProjectCommandsDir(): string;
    getProjectSkillsDir(): string;
    getProjectAgentSkillsDir(): string;
    getProjectAgentsDir(): string;
    getProjectTempCheckpointsDir(): string;
    getProjectTempLogsDir(): string;
    getProjectTempPlansDir(): string;
    getProjectTempTrackerDir(): string;
    getPlansDir(): string;
    getProjectTempTasksDir(): string;
    listProjectChatFiles(): Promise<Array<{
        filePath: string;
        lastUpdated: string;
    }>>;
    loadProjectTempFile<T>(filePath: string): Promise<T | null>;
    getExtensionsDir(): string;
    getExtensionsConfigPath(): string;
    getHistoryFilePath(): string;
}
