/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Config } from '../../config/config.js';
import type { BaseLlmClient } from '../../core/baseLlmClient.js';
import type { RoutingContext, RoutingDecision, TerminalStrategy } from '../routingStrategy.js';
import type { LocalLiteRtLmClient } from '../../core/localLiteRtLmClient.js';
export declare class DefaultStrategy implements TerminalStrategy {
    readonly name = "default";
    route(_context: RoutingContext, config: Config, _baseLlmClient: BaseLlmClient, _localLiteRtLmClient: LocalLiteRtLmClient): Promise<RoutingDecision>;
}
