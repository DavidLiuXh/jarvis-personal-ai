/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Safely replaces text with literal strings, avoiding ECMAScript GetSubstitution issues.
 * Escapes $ characters to prevent template interpretation.
 */
export declare function safeLiteralReplace(str: string, oldString: string, newString: string): string;
/**
 * Checks if a Buffer is likely binary by testing for the presence of a NULL byte.
 * The presence of a NULL byte is a strong indicator that the data is not plain text.
 * @param data The Buffer to check.
 * @param sampleSize The number of bytes from the start of the buffer to test.
 * @returns True if a NULL byte is found, false otherwise.
 */
export declare function isBinary(data: Buffer | null | undefined, sampleSize?: number): boolean;
/**
 * Detects the line ending style of a string.
 * @param content The string content to analyze.
 * @returns '\r\n' for Windows-style, '\n' for Unix-style.
 */
export declare function detectLineEnding(content: string): '\r\n' | '\n';
/**
 * Truncates a string to a maximum length, appending a suffix if truncated.
 * @param str The string to truncate.
 * @param maxLength The maximum length of the string.
 * @param suffix The suffix to append if truncated (default: '...[TRUNCATED]').
 * @returns The truncated string.
 */
export declare function truncateString(str: string, maxLength: number, suffix?: string): string;
/**
 * Safely replaces placeholders in a template string with values from a replacements object.
 * This performs a single-pass replacement to prevent double-interpolation attacks.
 *
 * @param template The template string containing {{key}} placeholders.
 * @param replacements A record of keys to their replacement values.
 * @returns The resulting string with placeholders replaced.
 */
export declare function safeTemplateReplace(template: string, replacements: Record<string, string>): string;
