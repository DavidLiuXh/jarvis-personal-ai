/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Detects shorthand omission placeholders such as:
 * - (rest of methods ...)
 * - (rest of code ...)
 * - (unchanged code ...)
 * - // rest of methods ...
 *
 * Returns all placeholders found as normalized tokens.
 */
export declare function detectOmissionPlaceholders(text: string): string[];
