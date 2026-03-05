/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @fileoverview Model configuration for browser agent.
 *
 * Provides the default visual agent model and utilities for resolving
 * the configured model.
 */
import type { Config } from '../../config/config.js';
/**
 * Default model for the visual agent (Computer Use capable).
 */
export declare const VISUAL_AGENT_MODEL = "gemini-2.5-computer-use-preview-10-2025";
/**
 * Gets the visual agent model from config, falling back to default.
 *
 * @param config Runtime configuration
 * @returns The model to use for visual agent
 */
export declare function getVisualAgentModel(config: Config): string;
