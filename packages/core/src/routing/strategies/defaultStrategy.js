/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { resolveModel } from '../../config/models.js';
export class DefaultStrategy {
    name = 'default';
    async route(_context, config, _baseLlmClient, _localLiteRtLmClient) {
        const defaultModel = resolveModel(config.getModel(), config.getGemini31LaunchedSync?.() ?? false);
        return {
            model: defaultModel,
            metadata: {
                source: this.name,
                latencyMs: 0,
                reasoning: `Routing to default model: ${defaultModel}`,
            },
        };
    }
}
//# sourceMappingURL=defaultStrategy.js.map