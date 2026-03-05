/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Config } from '../config/config.js';
import type { ConsecaPolicyGenerationEvent, ConsecaVerdictEvent } from './types.js';
export declare function logConsecaPolicyGeneration(config: Config, event: ConsecaPolicyGenerationEvent): void;
export declare function logConsecaVerdict(config: Config, event: ConsecaVerdictEvent): void;
