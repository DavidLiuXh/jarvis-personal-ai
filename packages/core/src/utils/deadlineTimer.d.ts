/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * A utility that manages a timeout and an AbortController, allowing the
 * timeout to be paused, resumed, and dynamically extended.
 */
export declare class DeadlineTimer {
    private readonly controller;
    private timeoutId;
    private remainingMs;
    private lastStartedAt;
    private isPaused;
    constructor(timeoutMs: number, reason?: string);
    /** The AbortSignal managed by this timer. */
    get signal(): AbortSignal;
    /**
     * Pauses the timer, clearing any active timeout.
     */
    pause(): void;
    /**
     * Resumes the timer with the remaining budget.
     */
    resume(reason?: string): void;
    /**
     * Extends the current budget by the specified number of milliseconds.
     */
    extend(ms: number, reason?: string): void;
    /**
     * Aborts the signal immediately and clears any pending timers.
     */
    abort(reason?: unknown): void;
    private schedule;
}
