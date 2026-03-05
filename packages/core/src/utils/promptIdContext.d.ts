/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { AsyncLocalStorage } from 'node:async_hooks';
export declare const promptIdContext: AsyncLocalStorage<string>;
/**
 * Retrieves the prompt ID from the context, or generates a fallback if not found.
 * @param componentName The name of the component requesting the ID (used for the fallback prefix).
 * @returns The retrieved or generated prompt ID.
 */
export declare function getPromptIdWithFallback(componentName: string): string;
