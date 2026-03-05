/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { GemmaClassifierStrategy } from './strategies/gemmaClassifierStrategy.js';
import { DefaultStrategy } from './strategies/defaultStrategy.js';
import { ClassifierStrategy } from './strategies/classifierStrategy.js';
import { NumericalClassifierStrategy } from './strategies/numericalClassifierStrategy.js';
import { CompositeStrategy } from './strategies/compositeStrategy.js';
import { FallbackStrategy } from './strategies/fallbackStrategy.js';
import { OverrideStrategy } from './strategies/overrideStrategy.js';
import { ApprovalModeStrategy } from './strategies/approvalModeStrategy.js';
import { logModelRouting } from '../telemetry/loggers.js';
import { ModelRoutingEvent } from '../telemetry/types.js';
import { debugLogger } from '../utils/debugLogger.js';
/**
 * A centralized service for making model routing decisions.
 */
export class ModelRouterService {
    config;
    strategy;
    constructor(config) {
        this.config = config;
        this.strategy = this.initializeDefaultStrategy();
    }
    initializeDefaultStrategy() {
        const strategies = [];
        // Order matters here. Fallback and override are checked first.
        strategies.push(new FallbackStrategy());
        strategies.push(new OverrideStrategy());
        // Approval mode is next.
        strategies.push(new ApprovalModeStrategy());
        // Then, if enabled, the Gemma classifier is used.
        if (this.config.getGemmaModelRouterSettings()?.enabled) {
            strategies.push(new GemmaClassifierStrategy());
        }
        // The generic classifier is next.
        strategies.push(new ClassifierStrategy());
        // The numerical classifier is next.
        strategies.push(new NumericalClassifierStrategy());
        // The default strategy is the terminal strategy.
        const terminalStrategy = new DefaultStrategy();
        return new CompositeStrategy([...strategies, terminalStrategy], 'agent-router');
    }
    /**
     * Determines which model to use for a given request context.
     *
     * @param context The full context of the request.
     * @returns A promise that resolves to a RoutingDecision.
     */
    async route(context) {
        const startTime = Date.now();
        let decision;
        const [enableNumericalRouting, thresholdValue] = await Promise.all([
            this.config.getNumericalRoutingEnabled(),
            this.config.getClassifierThreshold(),
        ]);
        const classifierThreshold = thresholdValue !== undefined ? String(thresholdValue) : undefined;
        let failed = false;
        let error_message;
        try {
            decision = await this.strategy.route(context, this.config, this.config.getBaseLlmClient(), this.config.getLocalLiteRtLmClient());
            debugLogger.debug(`[Routing] Selected model: ${decision.model} (Source: ${decision.metadata.source}, Latency: ${decision.metadata.latencyMs}ms)\n\t[Routing] Reasoning: ${decision.metadata.reasoning}`);
        }
        catch (e) {
            failed = true;
            error_message = e instanceof Error ? e.message : String(e);
            // Create a fallback decision for logging purposes
            // We do not actually route here. This should never happen so we should
            // fail loudly to catch any issues where this happens.
            decision = {
                model: this.config.getModel(),
                metadata: {
                    source: 'router-exception',
                    latencyMs: Date.now() - startTime,
                    reasoning: 'An exception occurred during routing.',
                    error: error_message,
                },
            };
            debugLogger.debug(`[Routing] Exception during routing: ${error_message}\n\tFallback model: ${decision.model} (Source: ${decision.metadata.source})`);
        }
        finally {
            const event = new ModelRoutingEvent(decision.model, decision.metadata.source, decision.metadata.latencyMs, decision.metadata.reasoning, failed, error_message, this.config.getApprovalMode(), enableNumericalRouting, classifierThreshold);
            logModelRouting(this.config, event);
        }
        return decision;
    }
}
//# sourceMappingURL=modelRouterService.js.map