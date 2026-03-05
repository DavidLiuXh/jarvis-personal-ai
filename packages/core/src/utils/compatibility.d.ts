/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Detects if the current OS is Windows 10.
 * Windows 11 also reports as version 10.0, but with build numbers >= 22000.
 */
export declare function isWindows10(): boolean;
/**
 * Detects if the current terminal is a JetBrains-based IDE terminal.
 */
export declare function isJetBrainsTerminal(): boolean;
/**
 * Detects if the current terminal is the default Apple Terminal.app.
 */
export declare function isAppleTerminal(): boolean;
/**
 * Detects if the current terminal supports 256 colors (8-bit).
 */
export declare function supports256Colors(): boolean;
/**
 * Detects if the current terminal supports true color (24-bit).
 */
export declare function supportsTrueColor(): boolean;
export declare enum WarningPriority {
    Low = "low",
    High = "high"
}
export interface StartupWarning {
    id: string;
    message: string;
    priority: WarningPriority;
}
/**
 * Returns a list of compatibility warnings based on the current environment.
 */
export declare function getCompatibilityWarnings(options?: {
    isAlternateBuffer?: boolean;
}): StartupWarning[];
