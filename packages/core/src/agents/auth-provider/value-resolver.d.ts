/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Resolves a value that may be an environment variable reference,
 * a shell command, or a literal value.
 *
 * Supported formats:
 * - `$ENV_VAR`: Read from environment variable
 * - `!command`: Execute shell command and use output (trimmed)
 * - `$$` or `!!`: Escape prefix, returns rest as literal
 * - Any other string: Use as literal value
 *
 * @param value The value to resolve
 * @returns The resolved value
 * @throws Error if environment variable is not set or command fails
 */
export declare function resolveAuthValue(value: string): Promise<string>;
/**
 * Check if a value needs resolution (is an env var or command reference).
 */
export declare function needsResolution(value: string): boolean;
/**
 * Mask a sensitive value for logging purposes.
 * Shows the first and last 2 characters with asterisks in between.
 */
export declare function maskSensitiveValue(value: string): string;
