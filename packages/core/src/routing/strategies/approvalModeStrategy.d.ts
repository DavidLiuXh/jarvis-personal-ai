/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Config } from '../../config/config.js';
import type { BaseLlmClient } from '../../core/baseLlmClient.js';
import type { RoutingContext, RoutingDecision, RoutingStrategy } from '../routingStrategy.js';
/**
 * A strategy that routes based on the current ApprovalMode and plan status.
 *
 * - In PLAN mode: Routes to the PRO model for high-quality planning.
 * - In other modes with an approved plan: Routes to the FLASH model for efficient implementation.
 */
export declare class ApprovalModeStrategy implements RoutingStrategy {
    readonly name = "approval-mode";
    route(context: RoutingContext, config: Config, _baseLlmClient: BaseLlmClient): Promise<RoutingDecision | null>;
}
