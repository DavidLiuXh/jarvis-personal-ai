/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { type IdeInfo } from './detect-ide.js';
export type StdioConfig = {
    command: string;
    args: string[];
};
export type ConnectionConfig = {
    port?: string;
    authToken?: string;
    stdio?: StdioConfig;
};
export declare function validateWorkspacePath(ideWorkspacePath: string | undefined, cwd: string): {
    isValid: boolean;
    error?: string;
};
export declare function getPortFromEnv(): string | undefined;
export declare function getStdioConfigFromEnv(): StdioConfig | undefined;
export declare function getConnectionConfigFromFile(pid: number): Promise<(ConnectionConfig & {
    workspacePath?: string;
    ideInfo?: IdeInfo;
}) | undefined>;
export declare function createProxyAwareFetch(ideServerHost: string): Promise<(url: string | URL, init?: RequestInit) => Promise<Response>>;
export declare function getIdeServerHost(): string;
