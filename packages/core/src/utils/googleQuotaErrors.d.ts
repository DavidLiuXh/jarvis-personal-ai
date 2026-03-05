/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { type GoogleApiError } from './googleErrors.js';
/**
 * A non-retryable error indicating a hard quota limit has been reached (e.g., daily limit).
 */
export declare class TerminalQuotaError extends Error {
    readonly cause: GoogleApiError;
    retryDelayMs?: number;
    reason?: string;
    constructor(message: string, cause: GoogleApiError, retryDelaySeconds?: number, reason?: string);
    get isInsufficientCredits(): boolean;
}
/**
 * A retryable error indicating a temporary quota issue (e.g., per-minute limit).
 */
export declare class RetryableQuotaError extends Error {
    readonly cause: GoogleApiError;
    retryDelayMs?: number;
    constructor(message: string, cause: GoogleApiError, retryDelaySeconds?: number);
}
/**
 * An error indicating that user validation is required to continue.
 */
export declare class ValidationRequiredError extends Error {
    readonly cause?: GoogleApiError | undefined;
    validationLink?: string;
    validationDescription?: string;
    learnMoreUrl?: string;
    userHandled: boolean;
    constructor(message: string, cause?: GoogleApiError | undefined, validationLink?: string, validationDescription?: string, learnMoreUrl?: string);
}
/**
 * Analyzes a caught error and classifies it as a specific error type if applicable.
 *
 * Classification logic:
 * - 404 errors are classified as `ModelNotFoundError`.
 * - 403 errors with `VALIDATION_REQUIRED` from cloudcode-pa domains are classified
 *   as `ValidationRequiredError`.
 * - 429 errors are classified as either `TerminalQuotaError` or `RetryableQuotaError`:
 *   - CloudCode API: `RATE_LIMIT_EXCEEDED` → `RetryableQuotaError`, `QUOTA_EXHAUSTED` → `TerminalQuotaError`.
 *   - If the error indicates a daily limit (in QuotaFailure), it's a `TerminalQuotaError`.
 *   - If the error has a retry delay, it's a `RetryableQuotaError`.
 *   - If the error indicates a per-minute limit, it's a `RetryableQuotaError`.
 *   - If the error message contains the phrase "Please retry in X[s|ms]", it's a `RetryableQuotaError`.
 *
 * @param error The error to classify.
 * @returns A classified error or the original `unknown` error.
 */
export declare function classifyGoogleError(error: unknown): unknown;
