/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
export declare const ExperimentFlags: {
    readonly CONTEXT_COMPRESSION_THRESHOLD: 45740197;
    readonly USER_CACHING: 45740198;
    readonly BANNER_TEXT_NO_CAPACITY_ISSUES: 45740199;
    readonly BANNER_TEXT_CAPACITY_ISSUES: 45740200;
    readonly ENABLE_PREVIEW: 45740196;
    readonly ENABLE_NUMERICAL_ROUTING: 45750526;
    readonly CLASSIFIER_THRESHOLD: 45750527;
    readonly ENABLE_ADMIN_CONTROLS: 45752213;
    readonly MASKING_PROTECTION_THRESHOLD: 45758817;
    readonly MASKING_PRUNABLE_THRESHOLD: 45758818;
    readonly MASKING_PROTECT_LATEST_TURN: 45758819;
    readonly GEMINI_3_1_PRO_LAUNCHED: 45760185;
};
export type ExperimentFlagName = (typeof ExperimentFlags)[keyof typeof ExperimentFlags];
