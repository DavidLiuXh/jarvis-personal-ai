/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Expands environment variables in a string using the provided environment record.
 * Uses the standard `dotenv-expand` library to handle expansion consistently with
 * other tools.
 *
 * Supports POSIX/Bash syntax ($VAR, ${VAR}).
 * Note: Windows syntax (%VAR%) is not natively supported by dotenv-expand.
 *
 * @param str - The string containing environment variable placeholders.
 * @param env - A record of environment variable names and their values.
 * @returns The string with environment variables expanded. Missing variables resolve to an empty string.
 */
export declare function expandEnvVars(str: string, env: Record<string, string | undefined>): string;
