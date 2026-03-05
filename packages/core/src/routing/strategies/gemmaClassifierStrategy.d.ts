/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { BaseLlmClient } from '../../core/baseLlmClient.js';
import type { RoutingContext, RoutingDecision, RoutingStrategy } from '../routingStrategy.js';
import type { Config } from '../../config/config.js';
import type { LocalLiteRtLmClient } from '../../core/localLiteRtLmClient.js';
export declare class GemmaClassifierStrategy implements RoutingStrategy {
    readonly name = "gemma-classifier";
    private flattenChatHistory;
    route(context: RoutingContext, config: Config, _baseLlmClient: BaseLlmClient, client: LocalLiteRtLmClient): Promise<RoutingDecision | null>;
}
