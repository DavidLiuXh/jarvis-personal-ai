/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as child_process from 'node:child_process';
import * as process from 'node:process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { IDE_DEFINITIONS } from './detect-ide.js';
import { GEMINI_CLI_COMPANION_EXTENSION_NAME } from './constants.js';
import { homedir } from '../utils/paths.js';
async function findCommand(command, platform = process.platform) {
    // 1. Check PATH first.
    try {
        if (platform === 'win32') {
            const result = child_process
                .execSync(`where.exe ${command}`)
                .toString()
                .trim();
            // `where.exe` can return multiple paths. Return the first one.
            const firstPath = result.split(/\r?\n/)[0];
            if (firstPath) {
                return firstPath;
            }
        }
        else {
            child_process.execSync(`command -v ${command}`, {
                stdio: 'ignore',
            });
            return command;
        }
    }
    catch {
        // Not in PATH, continue to check common locations.
    }
    // 2. Check common installation locations.
    const locations = [];
    const homeDir = homedir();
    const appConfigs = {
        code: {
            mac: { appName: 'Visual Studio Code', supportDirName: 'Code' },
            win: { appName: 'Microsoft VS Code', appBinary: 'code.cmd' },
            linux: { appBinary: 'code' },
        },
        positron: {
            mac: { appName: 'Positron', supportDirName: 'Positron' },
            win: { appName: 'Positron', appBinary: 'positron.cmd' },
            linux: { appBinary: 'positron' },
        },
    };
    let appname;
    if (command === 'code' || command === 'code.cmd') {
        appname = 'code';
    }
    else if (command === 'positron' || command === 'positron.cmd') {
        appname = 'positron';
    }
    if (appname) {
        if (platform === 'darwin') {
            // macOS
            const macConfig = appConfigs[appname].mac;
            if (macConfig) {
                locations.push(`/Applications/${macConfig.appName}.app/Contents/Resources/app/bin/${appname}`, path.join(homeDir, `Library/Application Support/${macConfig.supportDirName}/bin/${appname}`));
            }
        }
        else if (platform === 'linux') {
            // Linux
            const linuxConfig = appConfigs[appname]?.linux;
            if (linuxConfig) {
                locations.push(`/usr/share/${linuxConfig.appBinary}/bin/${linuxConfig.appBinary}`, `/snap/bin/${linuxConfig.appBinary}`, path.join(homeDir, `.local/share/${linuxConfig.appBinary}/bin/${linuxConfig.appBinary}`));
            }
        }
        else if (platform === 'win32') {
            // Windows
            const winConfig = appConfigs[appname].win;
            if (winConfig) {
                const winAppName = winConfig.appName;
                locations.push(path.join(process.env['ProgramFiles'] || 'C:\\Program Files', winAppName, 'bin', winConfig.appBinary), path.join(homeDir, 'AppData', 'Local', 'Programs', winAppName, 'bin', winConfig.appBinary));
            }
        }
    }
    for (const location of locations) {
        if (fs.existsSync(location)) {
            return location;
        }
    }
    return null;
}
class VsCodeInstaller {
    ideInfo;
    platform;
    vsCodeCommand;
    constructor(ideInfo, platform = process.platform) {
        this.ideInfo = ideInfo;
        this.platform = platform;
        const command = platform === 'win32' ? 'code.cmd' : 'code';
        this.vsCodeCommand = findCommand(command, platform);
    }
    async install() {
        const commandPath = await this.vsCodeCommand;
        if (!commandPath) {
            return {
                success: false,
                message: `${this.ideInfo.displayName} CLI not found. Please ensure 'code' is in your system's PATH. For help, see https://code.visualstudio.com/docs/configure/command-line#_code-is-not-recognized-as-an-internal-or-external-command. You can also install the '${GEMINI_CLI_COMPANION_EXTENSION_NAME}' extension manually from the VS Code marketplace.`,
            };
        }
        try {
            const result = child_process.spawnSync(commandPath, [
                '--install-extension',
                'google.gemini-cli-vscode-ide-companion',
                '--force',
            ], { stdio: 'pipe', shell: this.platform === 'win32' });
            if (result.status !== 0) {
                throw new Error(`Failed to install extension: ${result.stderr?.toString()}`);
            }
            return {
                success: true,
                message: `${this.ideInfo.displayName} companion extension was installed successfully.`,
            };
        }
        catch (_error) {
            return {
                success: false,
                message: `Failed to install ${this.ideInfo.displayName} companion extension. Please try installing '${GEMINI_CLI_COMPANION_EXTENSION_NAME}' manually from the ${this.ideInfo.displayName} extension marketplace.`,
            };
        }
    }
}
class PositronInstaller {
    ideInfo;
    platform;
    vsCodeCommand;
    constructor(ideInfo, platform = process.platform) {
        this.ideInfo = ideInfo;
        this.platform = platform;
        const command = platform === 'win32' ? 'positron.cmd' : 'positron';
        this.vsCodeCommand = findCommand(command, platform);
    }
    async install() {
        const commandPath = await this.vsCodeCommand;
        if (!commandPath) {
            return {
                success: false,
                message: `${this.ideInfo.displayName} CLI not found. Please ensure 'positron' is in your system's PATH. For help, see https://positron.posit.co/add-to-path.html. You can also install the '${GEMINI_CLI_COMPANION_EXTENSION_NAME}' extension manually from the VS Code marketplace / Open VSX registry.`,
            };
        }
        try {
            const result = child_process.spawnSync(commandPath, [
                '--install-extension',
                'google.gemini-cli-vscode-ide-companion',
                '--force',
            ], { stdio: 'pipe', shell: this.platform === 'win32' });
            if (result.status !== 0) {
                throw new Error(`Failed to install extension: ${result.stderr?.toString()}`);
            }
            return {
                success: true,
                message: `${this.ideInfo.displayName} companion extension was installed successfully.`,
            };
        }
        catch (_error) {
            return {
                success: false,
                message: `Failed to install ${this.ideInfo.displayName} companion extension. Please try installing '${GEMINI_CLI_COMPANION_EXTENSION_NAME}' manually from the ${this.ideInfo.displayName} extension marketplace.`,
            };
        }
    }
}
class AntigravityInstaller {
    ideInfo;
    platform;
    constructor(ideInfo, platform = process.platform) {
        this.ideInfo = ideInfo;
        this.platform = platform;
    }
    async install() {
        const command = process.env['ANTIGRAVITY_CLI_ALIAS'];
        if (!command) {
            return {
                success: false,
                message: 'ANTIGRAVITY_CLI_ALIAS environment variable not set.',
            };
        }
        const commandPath = await findCommand(command, this.platform);
        if (!commandPath) {
            return {
                success: false,
                message: `${command} not found. Please ensure it is in your system's PATH.`,
            };
        }
        try {
            const result = child_process.spawnSync(commandPath, [
                '--install-extension',
                'google.gemini-cli-vscode-ide-companion',
                '--force',
            ], { stdio: 'pipe', shell: this.platform === 'win32' });
            if (result.status !== 0) {
                throw new Error(`Failed to install extension: ${result.stderr?.toString()}`);
            }
            return {
                success: true,
                message: `${this.ideInfo.displayName} companion extension was installed successfully.`,
            };
        }
        catch (_error) {
            return {
                success: false,
                message: `Failed to install ${this.ideInfo.displayName} companion extension. Please try installing '${GEMINI_CLI_COMPANION_EXTENSION_NAME}' manually from the ${this.ideInfo.displayName} extension marketplace.`,
            };
        }
    }
}
export function getIdeInstaller(ide, platform = process.platform) {
    switch (ide.name) {
        case IDE_DEFINITIONS.vscode.name:
        case IDE_DEFINITIONS.firebasestudio.name:
            return new VsCodeInstaller(ide, platform);
        case IDE_DEFINITIONS.positron.name:
            return new PositronInstaller(ide, platform);
        case IDE_DEFINITIONS.antigravity.name:
            return new AntigravityInstaller(ide, platform);
        default:
            return null;
    }
}
//# sourceMappingURL=ide-installer.js.map