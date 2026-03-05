/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
export declare const IDE_DEFINITIONS: {
    readonly devin: {
        readonly name: "devin";
        readonly displayName: "Devin";
    };
    readonly replit: {
        readonly name: "replit";
        readonly displayName: "Replit";
    };
    readonly cursor: {
        readonly name: "cursor";
        readonly displayName: "Cursor";
    };
    readonly cloudshell: {
        readonly name: "cloudshell";
        readonly displayName: "Cloud Shell";
    };
    readonly codespaces: {
        readonly name: "codespaces";
        readonly displayName: "GitHub Codespaces";
    };
    readonly firebasestudio: {
        readonly name: "firebasestudio";
        readonly displayName: "Firebase Studio";
    };
    readonly trae: {
        readonly name: "trae";
        readonly displayName: "Trae";
    };
    readonly vscode: {
        readonly name: "vscode";
        readonly displayName: "VS Code";
    };
    readonly vscodefork: {
        readonly name: "vscodefork";
        readonly displayName: "IDE";
    };
    readonly positron: {
        readonly name: "positron";
        readonly displayName: "Positron";
    };
    readonly antigravity: {
        readonly name: "antigravity";
        readonly displayName: "Antigravity";
    };
    readonly sublimetext: {
        readonly name: "sublimetext";
        readonly displayName: "Sublime Text";
    };
    readonly jetbrains: {
        readonly name: "jetbrains";
        readonly displayName: "JetBrains IDE";
    };
    readonly intellijidea: {
        readonly name: "intellijidea";
        readonly displayName: "IntelliJ IDEA";
    };
    readonly webstorm: {
        readonly name: "webstorm";
        readonly displayName: "WebStorm";
    };
    readonly pycharm: {
        readonly name: "pycharm";
        readonly displayName: "PyCharm";
    };
    readonly goland: {
        readonly name: "goland";
        readonly displayName: "GoLand";
    };
    readonly androidstudio: {
        readonly name: "androidstudio";
        readonly displayName: "Android Studio";
    };
    readonly clion: {
        readonly name: "clion";
        readonly displayName: "CLion";
    };
    readonly rustrover: {
        readonly name: "rustrover";
        readonly displayName: "RustRover";
    };
    readonly datagrip: {
        readonly name: "datagrip";
        readonly displayName: "DataGrip";
    };
    readonly phpstorm: {
        readonly name: "phpstorm";
        readonly displayName: "PhpStorm";
    };
};
export interface IdeInfo {
    name: string;
    displayName: string;
}
export declare function isCloudShell(): boolean;
export declare function detectIdeFromEnv(): IdeInfo;
export declare function detectIde(ideProcessInfo: {
    pid: number;
    command: string;
}, ideInfoFromFile?: {
    name?: string;
    displayName?: string;
}): IdeInfo | undefined;
