/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/** Default timeout for SIGKILL escalation on Unix systems. */
export declare const SIGKILL_TIMEOUT_MS = 200;
/** Configuration for process termination. */
export interface KillOptions {
    /** The process ID to terminate. */
    pid: number;
    /** Whether to attempt SIGTERM before SIGKILL on Unix systems. */
    escalate?: boolean;
    /** Initial signal to use (defaults to SIGTERM if escalate is true, else SIGKILL). */
    signal?: NodeJS.Signals | number;
    /** Callback to check if the process has already exited. */
    isExited?: () => boolean;
    /** Optional PTY object for PTY-specific kill methods. */
    pty?: {
        kill: (signal?: string) => void;
    };
}
/**
 * Robustly terminates a process or process group across platforms.
 *
 * On Windows, it uses `taskkill /f /t` to ensure the entire tree is terminated,
 * or the PTY's built-in kill method.
 *
 * On Unix, it attempts to kill the process group (using -pid) with escalation
 * from SIGTERM to SIGKILL if requested.
 */
export declare function killProcessGroup(options: KillOptions): Promise<void>;
