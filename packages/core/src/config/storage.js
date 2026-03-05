/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { GEMINI_DIR, homedir, GOOGLE_ACCOUNTS_FILENAME, isSubpath, resolveToRealPath, normalizePath, } from '../utils/paths.js';
import { ProjectRegistry } from './projectRegistry.js';
import { StorageMigration } from './storageMigration.js';
export const OAUTH_FILE = 'oauth_creds.json';
const TMP_DIR_NAME = 'tmp';
const BIN_DIR_NAME = 'bin';
const AGENTS_DIR_NAME = '.agents';
export const AUTO_SAVED_POLICY_FILENAME = 'auto-saved.toml';
export class Storage {
    targetDir;
    sessionId;
    projectIdentifier;
    initPromise;
    customPlansDir;
    constructor(targetDir, sessionId) {
        this.targetDir = targetDir;
        this.sessionId = sessionId;
    }
    setCustomPlansDir(dir) {
        this.customPlansDir = dir;
    }
    static getGlobalGeminiDir() {
        const homeDir = homedir();
        if (!homeDir) {
            return path.join(os.tmpdir(), GEMINI_DIR);
        }
        return path.join(homeDir, GEMINI_DIR);
    }
    static getGlobalAgentsDir() {
        const homeDir = homedir();
        if (!homeDir) {
            return '';
        }
        return path.join(homeDir, AGENTS_DIR_NAME);
    }
    static getMcpOAuthTokensPath() {
        return path.join(Storage.getGlobalGeminiDir(), 'mcp-oauth-tokens.json');
    }
    static getGlobalSettingsPath() {
        return path.join(Storage.getGlobalGeminiDir(), 'settings.json');
    }
    static getInstallationIdPath() {
        return path.join(Storage.getGlobalGeminiDir(), 'installation_id');
    }
    static getGoogleAccountsPath() {
        return path.join(Storage.getGlobalGeminiDir(), GOOGLE_ACCOUNTS_FILENAME);
    }
    static getUserCommandsDir() {
        return path.join(Storage.getGlobalGeminiDir(), 'commands');
    }
    static getUserSkillsDir() {
        return path.join(Storage.getGlobalGeminiDir(), 'skills');
    }
    static getUserAgentSkillsDir() {
        return path.join(Storage.getGlobalAgentsDir(), 'skills');
    }
    static getGlobalMemoryFilePath() {
        return path.join(Storage.getGlobalGeminiDir(), 'memory.md');
    }
    static getUserPoliciesDir() {
        return path.join(Storage.getGlobalGeminiDir(), 'policies');
    }
    static getUserAgentsDir() {
        return path.join(Storage.getGlobalGeminiDir(), 'agents');
    }
    static getAcknowledgedAgentsPath() {
        return path.join(Storage.getGlobalGeminiDir(), 'acknowledgments', 'agents.json');
    }
    static getPolicyIntegrityStoragePath() {
        return path.join(Storage.getGlobalGeminiDir(), 'policy_integrity.json');
    }
    static getSystemConfigDir() {
        if (os.platform() === 'darwin') {
            return '/Library/Application Support/GeminiCli';
        }
        else if (os.platform() === 'win32') {
            return 'C:\\ProgramData\\gemini-cli';
        }
        else {
            return '/etc/gemini-cli';
        }
    }
    static getSystemSettingsPath() {
        if (process.env['GEMINI_CLI_SYSTEM_SETTINGS_PATH']) {
            return process.env['GEMINI_CLI_SYSTEM_SETTINGS_PATH'];
        }
        return path.join(Storage.getSystemConfigDir(), 'settings.json');
    }
    static getSystemPoliciesDir() {
        return path.join(Storage.getSystemConfigDir(), 'policies');
    }
    static getGlobalTempDir() {
        return path.join(Storage.getGlobalGeminiDir(), TMP_DIR_NAME);
    }
    static getGlobalBinDir() {
        return path.join(Storage.getGlobalTempDir(), BIN_DIR_NAME);
    }
    getGeminiDir() {
        return path.join(this.targetDir, GEMINI_DIR);
    }
    /**
     * Checks if the current workspace storage location is the same as the global/user storage location.
     * This handles symlinks and platform-specific path normalization.
     */
    isWorkspaceHomeDir() {
        return (normalizePath(resolveToRealPath(this.targetDir)) ===
            normalizePath(resolveToRealPath(homedir())));
    }
    getAgentsDir() {
        return path.join(this.targetDir, AGENTS_DIR_NAME);
    }
    getProjectTempDir() {
        const identifier = this.getProjectIdentifier();
        const tempDir = Storage.getGlobalTempDir();
        return path.join(tempDir, identifier);
    }
    getWorkspacePoliciesDir() {
        return path.join(this.getGeminiDir(), 'policies');
    }
    getAutoSavedPolicyPath() {
        return path.join(Storage.getUserPoliciesDir(), AUTO_SAVED_POLICY_FILENAME);
    }
    ensureProjectTempDirExists() {
        fs.mkdirSync(this.getProjectTempDir(), { recursive: true });
    }
    static getOAuthCredsPath() {
        return path.join(Storage.getGlobalGeminiDir(), OAUTH_FILE);
    }
    getProjectRoot() {
        return this.targetDir;
    }
    getFilePathHash(filePath) {
        return crypto.createHash('sha256').update(filePath).digest('hex');
    }
    getProjectIdentifier() {
        if (!this.projectIdentifier) {
            throw new Error('Storage must be initialized before use');
        }
        return this.projectIdentifier;
    }
    /**
     * Initializes storage by setting up the project registry and performing migrations.
     */
    async initialize() {
        if (this.initPromise) {
            return this.initPromise;
        }
        this.initPromise = (async () => {
            if (this.projectIdentifier) {
                return;
            }
            const registryPath = path.join(Storage.getGlobalGeminiDir(), 'projects.json');
            const registry = new ProjectRegistry(registryPath, [
                Storage.getGlobalTempDir(),
                path.join(Storage.getGlobalGeminiDir(), 'history'),
            ]);
            await registry.initialize();
            this.projectIdentifier = await registry.getShortId(this.getProjectRoot());
            await this.performMigration();
        })();
        return this.initPromise;
    }
    /**
     * Performs migration of legacy hash-based directories to the new slug-based format.
     * This is called internally by initialize().
     */
    async performMigration() {
        const shortId = this.getProjectIdentifier();
        const oldHash = this.getFilePathHash(this.getProjectRoot());
        // Migrate Temp Dir
        const newTempDir = path.join(Storage.getGlobalTempDir(), shortId);
        const oldTempDir = path.join(Storage.getGlobalTempDir(), oldHash);
        await StorageMigration.migrateDirectory(oldTempDir, newTempDir);
        // Migrate History Dir
        const historyDir = path.join(Storage.getGlobalGeminiDir(), 'history');
        const newHistoryDir = path.join(historyDir, shortId);
        const oldHistoryDir = path.join(historyDir, oldHash);
        await StorageMigration.migrateDirectory(oldHistoryDir, newHistoryDir);
    }
    getHistoryDir() {
        const identifier = this.getProjectIdentifier();
        const historyDir = path.join(Storage.getGlobalGeminiDir(), 'history');
        return path.join(historyDir, identifier);
    }
    getWorkspaceSettingsPath() {
        return path.join(this.getGeminiDir(), 'settings.json');
    }
    getProjectCommandsDir() {
        return path.join(this.getGeminiDir(), 'commands');
    }
    getProjectSkillsDir() {
        return path.join(this.getGeminiDir(), 'skills');
    }
    getProjectAgentSkillsDir() {
        return path.join(this.getAgentsDir(), 'skills');
    }
    getProjectAgentsDir() {
        return path.join(this.getGeminiDir(), 'agents');
    }
    getProjectTempCheckpointsDir() {
        return path.join(this.getProjectTempDir(), 'checkpoints');
    }
    getProjectTempLogsDir() {
        return path.join(this.getProjectTempDir(), 'logs');
    }
    getProjectTempPlansDir() {
        if (this.sessionId) {
            return path.join(this.getProjectTempDir(), this.sessionId, 'plans');
        }
        return path.join(this.getProjectTempDir(), 'plans');
    }
    getProjectTempTrackerDir() {
        return path.join(this.getProjectTempDir(), 'tracker');
    }
    getPlansDir() {
        if (this.customPlansDir) {
            const resolvedPath = path.resolve(this.getProjectRoot(), this.customPlansDir);
            const realProjectRoot = resolveToRealPath(this.getProjectRoot());
            const realResolvedPath = resolveToRealPath(resolvedPath);
            if (!isSubpath(realProjectRoot, realResolvedPath)) {
                throw new Error(`Custom plans directory '${this.customPlansDir}' resolves to '${realResolvedPath}', which is outside the project root '${realProjectRoot}'.`);
            }
            return resolvedPath;
        }
        return this.getProjectTempPlansDir();
    }
    getProjectTempTasksDir() {
        if (this.sessionId) {
            return path.join(this.getProjectTempDir(), this.sessionId, 'tasks');
        }
        return path.join(this.getProjectTempDir(), 'tasks');
    }
    async listProjectChatFiles() {
        const chatsDir = path.join(this.getProjectTempDir(), 'chats');
        try {
            const files = await fs.promises.readdir(chatsDir);
            const jsonFiles = files.filter((f) => f.endsWith('.json'));
            const sessions = await Promise.all(jsonFiles.map(async (file) => {
                const absolutePath = path.join(chatsDir, file);
                const stats = await fs.promises.stat(absolutePath);
                return {
                    filePath: path.join('chats', file),
                    lastUpdated: stats.mtime.toISOString(),
                    mtimeMs: stats.mtimeMs,
                };
            }));
            return sessions
                .sort((a, b) => b.mtimeMs - a.mtimeMs)
                .map(({ filePath, lastUpdated }) => ({ filePath, lastUpdated }));
        }
        catch (e) {
            // If directory doesn't exist, return empty
            if (e instanceof Error &&
                'code' in e &&
                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
                e.code === 'ENOENT') {
                return [];
            }
            throw e;
        }
    }
    async loadProjectTempFile(filePath) {
        const absolutePath = path.join(this.getProjectTempDir(), filePath);
        try {
            const content = await fs.promises.readFile(absolutePath, 'utf8');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            return JSON.parse(content);
        }
        catch (e) {
            // If file doesn't exist, return null
            if (e instanceof Error &&
                'code' in e &&
                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
                e.code === 'ENOENT') {
                return null;
            }
            throw e;
        }
    }
    getExtensionsDir() {
        return path.join(this.getGeminiDir(), 'extensions');
    }
    getExtensionsConfigPath() {
        return path.join(this.getExtensionsDir(), 'gemini-extension.json');
    }
    getHistoryFilePath() {
        return path.join(this.getProjectTempDir(), 'shell_history');
    }
}
//# sourceMappingURL=storage.js.map