/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { type AnsiOutput } from '../utils/terminalSerializer.js';
import { type EnvironmentSanitizationConfig } from './environmentSanitization.js';
/**
 * An environment variable that is set for shell executions. This can be used
 * by downstream executables and scripts to identify that they were executed
 * from within Gemini CLI.
 */
export declare const GEMINI_CLI_IDENTIFICATION_ENV_VAR = "GEMINI_CLI";
/**
 * The value of {@link GEMINI_CLI_IDENTIFICATION_ENV_VAR}
 */
export declare const GEMINI_CLI_IDENTIFICATION_ENV_VAR_VALUE = "1";
export declare const SCROLLBACK_LIMIT = 300000;
/** A structured result from a shell command execution. */
export interface ShellExecutionResult {
    /** The raw, unprocessed output buffer. */
    rawOutput: Buffer;
    /** The combined, decoded output as a string. */
    output: string;
    /** The process exit code, or null if terminated by a signal. */
    exitCode: number | null;
    /** The signal that terminated the process, if any. */
    signal: number | null;
    /** An error object if the process failed to spawn. */
    error: Error | null;
    /** A boolean indicating if the command was aborted by the user. */
    aborted: boolean;
    /** The process ID of the spawned shell. */
    pid: number | undefined;
    /** The method used to execute the shell command. */
    executionMethod: 'lydell-node-pty' | 'node-pty' | 'child_process' | 'none';
    /** Whether the command was moved to the background. */
    backgrounded?: boolean;
}
/** A handle for an ongoing shell execution. */
export interface ShellExecutionHandle {
    /** The process ID of the spawned shell. */
    pid: number | undefined;
    /** A promise that resolves with the complete execution result. */
    result: Promise<ShellExecutionResult>;
}
export interface ShellExecutionConfig {
    terminalWidth?: number;
    terminalHeight?: number;
    pager?: string;
    showColor?: boolean;
    defaultFg?: string;
    defaultBg?: string;
    sanitizationConfig: EnvironmentSanitizationConfig;
    disableDynamicLineTrimming?: boolean;
    scrollback?: number;
    maxSerializedLines?: number;
}
/**
 * Describes a structured event emitted during shell command execution.
 */
export type ShellOutputEvent = {
    /** The event contains a chunk of output data. */
    type: 'data';
    /** The decoded string chunk. */
    chunk: string | AnsiOutput;
} | {
    /** Signals that the output stream has been identified as binary. */
    type: 'binary_detected';
} | {
    /** Provides progress updates for a binary stream. */
    type: 'binary_progress';
    /** The total number of bytes received so far. */
    bytesReceived: number;
} | {
    /** Signals that the process has exited. */
    type: 'exit';
    /** The exit code of the process, if any. */
    exitCode: number | null;
    /** The signal that terminated the process, if any. */
    signal: number | null;
};
/**
 * A centralized service for executing shell commands with robust process
 * management, cross-platform compatibility, and streaming output capabilities.
 *
 */
export declare class ShellExecutionService {
    private static activePtys;
    private static activeChildProcesses;
    private static exitedPtyInfo;
    private static activeResolvers;
    private static activeListeners;
    /**
     * Executes a shell command using `node-pty`, capturing all output and lifecycle events.
     *
     * @param commandToExecute The exact command string to run.
     * @param cwd The working directory to execute the command in.
     * @param onOutputEvent A callback for streaming structured events about the execution, including data chunks and status updates.
     * @param abortSignal An AbortSignal to terminate the process and its children.
     * @returns An object containing the process ID (pid) and a promise that
     *          resolves with the complete execution result.
     */
    static execute(commandToExecute: string, cwd: string, onOutputEvent: (event: ShellOutputEvent) => void, abortSignal: AbortSignal, shouldUseNodePty: boolean, shellExecutionConfig: ShellExecutionConfig): Promise<ShellExecutionHandle>;
    private static appendAndTruncate;
    private static emitEvent;
    private static childProcessFallback;
    private static executeWithPty;
    /**
     * Writes a string to the pseudo-terminal (PTY) of a running process.
     *
     * @param pid The process ID of the target PTY.
     * @param input The string to write to the terminal.
     */
    static writeToPty(pid: number, input: string): void;
    static isPtyActive(pid: number): boolean;
    /**
     * Registers a callback to be invoked when the process with the given PID exits.
     * This attaches directly to the PTY's exit event.
     *
     * @param pid The process ID to watch.
     * @param callback The function to call on exit.
     * @returns An unsubscribe function.
     */
    static onExit(pid: number, callback: (exitCode: number, signal?: number) => void): () => void;
    /**
     * Kills a process by its PID.
     *
     * @param pid The process ID to kill.
     */
    static kill(pid: number): void;
    /**
     * Moves a running shell command to the background.
     * This resolves the execution promise but keeps the PTY active.
     *
     * @param pid The process ID of the target PTY.
     */
    static background(pid: number): void;
    static subscribe(pid: number, listener: (event: ShellOutputEvent) => void): () => void;
    /**
     * Resizes the pseudo-terminal (PTY) of a running process.
     *
     * @param pid The process ID of the target PTY.
     * @param cols The new number of columns.
     * @param rows The new number of rows.
     */
    static resizePty(pid: number, cols: number, rows: number): void;
    /**
     * Scrolls the pseudo-terminal (PTY) of a running process.
     *
     * @param pid The process ID of the target PTY.
     * @param lines The number of lines to scroll.
     */
    static scrollPty(pid: number, lines: number): void;
}
