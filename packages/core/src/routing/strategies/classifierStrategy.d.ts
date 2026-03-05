/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { BaseLlmClient } from '../../core/baseLlmClient.js';
import type { RoutingContext, RoutingDecision, RoutingStrategy } from '../routingStrategy.js';
import type { Config } from '../../config/config.js';
import type { LocalLiteRtLmClient } from '../../core/localLiteRtLmClient.js';
export declare class ClassifierStrategy implements RoutingStrategy {
    readonly name = "classifier";
    route(context: RoutingContext, config: Config, baseLlmClient: BaseLlmClient, _localLiteRtLmClient: LocalLiteRtLmClient): Promise<RoutingDecision | null>;
}
