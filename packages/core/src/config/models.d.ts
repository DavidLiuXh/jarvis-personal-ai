/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
export declare const PREVIEW_GEMINI_MODEL = "gemini-3-pro-preview";
export declare const PREVIEW_GEMINI_3_1_MODEL = "gemini-3.1-pro-preview";
export declare const PREVIEW_GEMINI_3_1_CUSTOM_TOOLS_MODEL = "gemini-3.1-pro-preview-customtools";
export declare const PREVIEW_GEMINI_FLASH_MODEL = "gemini-3-flash-preview";
export declare const DEFAULT_GEMINI_MODEL = "gemini-2.5-pro";
export declare const DEFAULT_GEMINI_FLASH_MODEL = "gemini-2.5-flash";
export declare const DEFAULT_GEMINI_FLASH_LITE_MODEL = "gemini-2.5-flash-lite";
export declare const VALID_GEMINI_MODELS: Set<string>;
export declare const PREVIEW_GEMINI_MODEL_AUTO = "auto-gemini-3";
export declare const DEFAULT_GEMINI_MODEL_AUTO = "auto-gemini-2.5";
export declare const GEMINI_MODEL_ALIAS_AUTO = "auto";
export declare const GEMINI_MODEL_ALIAS_PRO = "pro";
export declare const GEMINI_MODEL_ALIAS_FLASH = "flash";
export declare const GEMINI_MODEL_ALIAS_FLASH_LITE = "flash-lite";
export declare const DEFAULT_GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";
export declare const DEFAULT_THINKING_MODE = 8192;
/**
 * Resolves the requested model alias (e.g., 'auto-gemini-3', 'pro', 'flash', 'flash-lite')
 * to a concrete model name.
 *
 * @param requestedModel The model alias or concrete model name requested by the user.
 * @param useGemini3_1 Whether to use Gemini 3.1 Pro Preview for auto/pro aliases.
 * @returns The resolved concrete model name.
 */
export declare function resolveModel(requestedModel: string, useGemini3_1?: boolean, useCustomToolModel?: boolean): string;
/**
 * Resolves the appropriate model based on the classifier's decision.
 *
 * @param requestedModel The current requested model (e.g. auto-gemini-2.5).
 * @param modelAlias The alias selected by the classifier ('flash' or 'pro').
 * @returns The resolved concrete model name.
 */
export declare function resolveClassifierModel(requestedModel: string, modelAlias: string, useGemini3_1?: boolean, useCustomToolModel?: boolean): string;
export declare function getDisplayString(model: string): string;
/**
 * Checks if the model is a preview model.
 *
 * @param model The model name to check.
 * @returns True if the model is a preview model.
 */
export declare function isPreviewModel(model: string): boolean;
/**
 * Checks if the model is a Pro model.
 *
 * @param model The model name to check.
 * @returns True if the model is a Pro model.
 */
export declare function isProModel(model: string): boolean;
/**
 * Checks if the model is a Gemini 3 model.
 *
 * @param model The model name to check.
 * @returns True if the model is a Gemini 3 model.
 */
export declare function isGemini3Model(model: string): boolean;
/**
 * Checks if the model is a Gemini 2.x model.
 *
 * @param model The model name to check.
 * @returns True if the model is a Gemini-2.x model.
 */
export declare function isGemini2Model(model: string): boolean;
/**
 * Checks if the model is a "custom" model (not Gemini branded).
 *
 * @param model The model name to check.
 * @returns True if the model is not a Gemini branded model.
 */
export declare function isCustomModel(model: string): boolean;
/**
 * Checks if the model should be treated as a modern model.
 * This includes Gemini 3 models and any custom models.
 *
 * @param model The model name to check.
 * @returns True if the model supports modern features like thoughts.
 */
export declare function supportsModernFeatures(model: string): boolean;
/**
 * Checks if the model is an auto model.
 *
 * @param model The model name to check.
 * @returns True if the model is an auto model.
 */
export declare function isAutoModel(model: string): boolean;
/**
 * Checks if the model supports multimodal function responses (multimodal data nested within function response).
 * This is supported in Gemini 3.
 *
 * @param model The model name to check.
 * @returns True if the model supports multimodal function responses.
 */
export declare function supportsMultimodalFunctionResponse(model: string): boolean;
/**
 * Checks if the given model is considered active based on the current configuration.
 *
 * @param model The model name to check.
 * @param useGemini3_1 Whether Gemini 3.1 Pro Preview is enabled.
 * @returns True if the model is active.
 */
export declare function isActiveModel(model: string, useGemini3_1?: boolean, useCustomToolModel?: boolean): boolean;
