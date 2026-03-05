/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Traverses up the process tree to find the process ID and command of the IDE.
 *
 * This function uses different strategies depending on the operating system
 * to identify the main application process (e.g., the main VS Code window
 * process).
 *
 * This function can be overridden by setting the `GEMINI_CLI_IDE_PID`
 * environment variable. This is useful for launching Gemini CLI in a
 * standalone terminal while still connecting to an IDE instance.
 *
 * If `GEMINI_CLI_IDE_PID` is set, the function uses that PID and fetches
 * the command for it.
 *
 * If the IDE process cannot be reliably identified, it will return the
 * top-level ancestor process ID and command as a fallback.
 *
 * @returns A promise that resolves to the PID and command of the IDE process.
 */
export declare function getIdeProcessInfo(): Promise<{
    pid: number;
    command: string;
}>;
