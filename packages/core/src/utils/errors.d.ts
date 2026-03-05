/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
export declare function isNodeError(error: unknown): error is NodeJS.ErrnoException;
/**
 * Checks if an error is an AbortError.
 */
export declare function isAbortError(error: unknown): boolean;
export declare function getErrorMessage(error: unknown): string;
export declare function getErrorType(error: unknown): string;
export declare class FatalError extends Error {
    readonly exitCode: number;
    constructor(message: string, exitCode: number);
}
export declare class FatalAuthenticationError extends FatalError {
    constructor(message: string);
}
export declare class FatalInputError extends FatalError {
    constructor(message: string);
}
export declare class FatalSandboxError extends FatalError {
    constructor(message: string);
}
export declare class FatalConfigError extends FatalError {
    constructor(message: string);
}
export declare class FatalTurnLimitedError extends FatalError {
    constructor(message: string);
}
export declare class FatalToolExecutionError extends FatalError {
    constructor(message: string);
}
export declare class FatalCancellationError extends FatalError {
    constructor(message: string);
}
export declare class CanceledError extends Error {
    constructor(message?: string);
}
export declare class ForbiddenError extends Error {
}
export declare class AccountSuspendedError extends ForbiddenError {
    readonly appealUrl?: string;
    readonly appealLinkText?: string;
    constructor(message: string, metadata?: Record<string, string>);
}
export declare class UnauthorizedError extends Error {
}
export declare class BadRequestError extends Error {
}
export declare class ChangeAuthRequestedError extends Error {
    constructor();
}
export declare function toFriendlyError(error: unknown): unknown;
export declare function isAccountSuspendedError(error: unknown): AccountSuspendedError | null;
/**
 * Checks if an error is a 401 authentication error.
 * Uses structured error properties from MCP SDK errors.
 *
 * @param error The error to check
 * @returns true if this is a 401/authentication error
 */
export declare function isAuthenticationError(error: unknown): boolean;
