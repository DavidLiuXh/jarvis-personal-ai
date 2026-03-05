/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { type GenerateContentResponse } from '@google/genai';
import { ValidationRequiredError } from './googleQuotaErrors.js';
import type { RetryAvailabilityContext } from '../availability/modelPolicy.js';
export type { RetryAvailabilityContext };
export declare const DEFAULT_MAX_ATTEMPTS = 10;
export interface RetryOptions {
    maxAttempts: number;
    initialDelayMs: number;
    maxDelayMs: number;
    shouldRetryOnError: (error: Error, retryFetchErrors?: boolean) => boolean;
    shouldRetryOnContent?: (content: GenerateContentResponse) => boolean;
    onPersistent429?: (authType?: string, error?: unknown) => Promise<string | boolean | null>;
    onValidationRequired?: (error: ValidationRequiredError) => Promise<'verify' | 'change_auth' | 'cancel'>;
    authType?: string;
    retryFetchErrors?: boolean;
    signal?: AbortSignal;
    getAvailabilityContext?: () => RetryAvailabilityContext | undefined;
    onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}
/**
 * Default predicate function to determine if a retry should be attempted.
 * Retries on 429 (Too Many Requests) and 5xx server errors.
 * @param error The error object.
 * @param retryFetchErrors Whether to retry on specific fetch errors.
 * @returns True if the error is a transient error, false otherwise.
 */
export declare function isRetryableError(error: Error | unknown, retryFetchErrors?: boolean): boolean;
/**
 * Retries a function with exponential backoff and jitter.
 * @param fn The asynchronous function to retry.
 * @param options Optional retry configuration.
 * @returns A promise that resolves with the result of the function if successful.
 * @throws The last error encountered if all attempts fail.
 */
export declare function retryWithBackoff<T>(fn: () => Promise<T>, options?: Partial<RetryOptions>): Promise<T>;
