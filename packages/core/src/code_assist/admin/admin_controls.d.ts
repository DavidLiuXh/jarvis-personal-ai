/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CodeAssistServer } from '../server.js';
import { type FetchAdminControlsResponse, type AdminControlsSettings } from '../types.js';
import type { Config } from '../../config/config.js';
export declare function sanitizeAdminSettings(settings: FetchAdminControlsResponse): AdminControlsSettings;
/**
 * Fetches the admin controls from the server if enabled by experiment flag.
 * Safely handles polling start/stop based on the flag and server availability.
 *
 * @param server The CodeAssistServer instance.
 * @param cachedSettings The cached settings to use if available.
 * @param adminControlsEnabled Whether admin controls are enabled.
 * @param onSettingsChanged Callback to invoke when settings change during polling.
 * @returns The fetched settings if enabled and successful, otherwise undefined.
 */
export declare function fetchAdminControls(server: CodeAssistServer | undefined, cachedSettings: AdminControlsSettings | undefined, adminControlsEnabled: boolean, onSettingsChanged: (settings: AdminControlsSettings) => void): Promise<AdminControlsSettings>;
/**
 * Fetches the admin controls from the server a single time.
 * This function does not start or stop any polling.
 *
 * @param server The CodeAssistServer instance.
 * @param adminControlsEnabled Whether admin controls are enabled.
 * @returns The fetched settings if enabled and successful, otherwise undefined.
 */
export declare function fetchAdminControlsOnce(server: CodeAssistServer | undefined, adminControlsEnabled: boolean): Promise<FetchAdminControlsResponse>;
/**
 * Stops polling for admin controls.
 */
export declare function stopAdminControlsPolling(): void;
/**
 * Returns a standardized error message for features disabled by admin settings.
 *
 * @param featureName The name of the disabled feature
 * @param config The application config
 * @returns The formatted error message
 */
export declare function getAdminErrorMessage(featureName: string, config: Config | undefined): string;
/**
 * Returns a standardized error message for MCP servers blocked by the admin allowlist.
 *
 * @param blockedServers List of blocked server names
 * @param config The application config
 * @returns The formatted error message
 */
export declare function getAdminBlockedMcpServersMessage(blockedServers: string[], config: Config | undefined): string;
