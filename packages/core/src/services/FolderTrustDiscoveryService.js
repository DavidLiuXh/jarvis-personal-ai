/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import stripJsonComments from 'strip-json-comments';
import { GEMINI_DIR } from '../utils/paths.js';
import { debugLogger } from '../utils/debugLogger.js';
import { isNodeError } from '../utils/errors.js';
/**
 * A safe, read-only service to discover local configurations in a folder
 * before it is trusted.
 */
export class FolderTrustDiscoveryService {
    /**
     * Discovers configurations in the given workspace directory.
     * @param workspaceDir The directory to scan.
     * @returns A summary of discovered configurations.
     */
    static async discover(workspaceDir) {
        const results = {
            commands: [],
            mcps: [],
            hooks: [],
            skills: [],
            settings: [],
            securityWarnings: [],
            discoveryErrors: [],
        };
        const geminiDir = path.join(workspaceDir, GEMINI_DIR);
        if (!(await this.exists(geminiDir))) {
            return results;
        }
        await Promise.all([
            this.discoverCommands(geminiDir, results),
            this.discoverSkills(geminiDir, results),
            this.discoverSettings(geminiDir, results),
        ]);
        return results;
    }
    static async discoverCommands(geminiDir, results) {
        const commandsDir = path.join(geminiDir, 'commands');
        if (await this.exists(commandsDir)) {
            try {
                const files = await fs.readdir(commandsDir, { recursive: true });
                results.commands = files
                    .filter((f) => f.endsWith('.toml'))
                    .map((f) => path.basename(f, '.toml'));
            }
            catch (e) {
                results.discoveryErrors.push(`Failed to discover commands: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }
    static async discoverSkills(geminiDir, results) {
        const skillsDir = path.join(geminiDir, 'skills');
        if (await this.exists(skillsDir)) {
            try {
                const entries = await fs.readdir(skillsDir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        const skillMdPath = path.join(skillsDir, entry.name, 'SKILL.md');
                        if (await this.exists(skillMdPath)) {
                            results.skills.push(entry.name);
                        }
                    }
                }
            }
            catch (e) {
                results.discoveryErrors.push(`Failed to discover skills: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }
    static async discoverSettings(geminiDir, results) {
        const settingsPath = path.join(geminiDir, 'settings.json');
        if (!(await this.exists(settingsPath)))
            return;
        try {
            const content = await fs.readFile(settingsPath, 'utf-8');
            const settings = JSON.parse(stripJsonComments(content));
            if (!this.isRecord(settings)) {
                debugLogger.debug('Settings must be a JSON object');
                return;
            }
            results.settings = Object.keys(settings).filter((key) => !['mcpServers', 'hooks', '$schema'].includes(key));
            results.securityWarnings = this.collectSecurityWarnings(settings);
            const mcpServers = settings['mcpServers'];
            if (this.isRecord(mcpServers)) {
                results.mcps = Object.keys(mcpServers);
            }
            const hooksConfig = settings['hooks'];
            if (this.isRecord(hooksConfig)) {
                const hooks = new Set();
                for (const event of Object.values(hooksConfig)) {
                    if (!Array.isArray(event))
                        continue;
                    for (const hook of event) {
                        if (this.isRecord(hook) && typeof hook['command'] === 'string') {
                            hooks.add(hook['command']);
                        }
                    }
                }
                results.hooks = Array.from(hooks);
            }
        }
        catch (e) {
            results.discoveryErrors.push(`Failed to discover settings: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    static collectSecurityWarnings(settings) {
        const warnings = [];
        const tools = this.isRecord(settings['tools'])
            ? settings['tools']
            : undefined;
        const experimental = this.isRecord(settings['experimental'])
            ? settings['experimental']
            : undefined;
        const security = this.isRecord(settings['security'])
            ? settings['security']
            : undefined;
        const folderTrust = security && this.isRecord(security['folderTrust'])
            ? security['folderTrust']
            : undefined;
        const allowedTools = tools?.['allowed'];
        const checks = [
            {
                condition: Array.isArray(allowedTools) && allowedTools.length > 0,
                message: 'This project auto-approves certain tools (tools.allowed).',
            },
            {
                condition: experimental?.['enableAgents'] === true,
                message: 'This project enables autonomous agents (enableAgents).',
            },
            {
                condition: folderTrust?.['enabled'] === false,
                message: 'This project attempts to disable folder trust (security.folderTrust.enabled).',
            },
            {
                condition: tools?.['sandbox'] === false,
                message: 'This project disables the security sandbox (tools.sandbox).',
            },
        ];
        for (const check of checks) {
            if (check.condition)
                warnings.push(check.message);
        }
        return warnings;
    }
    static isRecord(val) {
        return !!val && typeof val === 'object' && !Array.isArray(val);
    }
    static async exists(filePath) {
        try {
            await fs.stat(filePath);
            return true;
        }
        catch (e) {
            if (isNodeError(e) && e.code === 'ENOENT') {
                return false;
            }
            throw e;
        }
    }
}
//# sourceMappingURL=FolderTrustDiscoveryService.js.map