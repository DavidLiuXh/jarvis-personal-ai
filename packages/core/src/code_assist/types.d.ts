/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from 'zod';
export interface ClientMetadata {
    ideType?: ClientMetadataIdeType;
    ideVersion?: string;
    pluginVersion?: string;
    platform?: ClientMetadataPlatform;
    updateChannel?: string;
    duetProject?: string;
    pluginType?: ClientMetadataPluginType;
    ideName?: string;
}
export type ClientMetadataIdeType = 'IDE_UNSPECIFIED' | 'VSCODE' | 'INTELLIJ' | 'VSCODE_CLOUD_WORKSTATION' | 'INTELLIJ_CLOUD_WORKSTATION' | 'CLOUD_SHELL' | 'GEMINI_CLI';
export type ClientMetadataPlatform = 'PLATFORM_UNSPECIFIED' | 'DARWIN_AMD64' | 'DARWIN_ARM64' | 'LINUX_AMD64' | 'LINUX_ARM64' | 'WINDOWS_AMD64';
export type ClientMetadataPluginType = 'PLUGIN_UNSPECIFIED' | 'CLOUD_CODE' | 'GEMINI' | 'AIPLUGIN_INTELLIJ' | 'AIPLUGIN_STUDIO';
/**
 * Credit types that can be used for API consumption.
 */
export type CreditType = 'CREDIT_TYPE_UNSPECIFIED' | 'GOOGLE_ONE_AI';
/**
 * Represents a credit amount for a specific credit type.
 * Used in LoadCodeAssistResponse for available credits and
 * in GenerateContentResponse for consumed/remaining credits.
 */
export interface Credits {
    creditType: CreditType;
    creditAmount: string;
}
/** Alias for Credits used in available_credits context */
export type AvailableCredits = Credits;
/** Alias for Credits used in consumedCredits context */
export type ConsumedCredits = Credits;
/** Alias for Credits used in remainingCredits context */
export type RemainingCredits = Credits;
export interface LoadCodeAssistRequest {
    cloudaicompanionProject?: string;
    metadata: ClientMetadata;
    mode?: LoadCodeAssistMode;
}
export type LoadCodeAssistMode = 'MODE_UNSPECIFIED' | 'FULL_ELIGIBILITY_CHECK' | 'HEALTH_CHECK';
/**
 * Represents LoadCodeAssistResponse proto json field
 * http://google3/google/internal/cloud/code/v1internal/cloudcode.proto;l=224
 */
export interface LoadCodeAssistResponse {
    currentTier?: GeminiUserTier | null;
    allowedTiers?: GeminiUserTier[] | null;
    ineligibleTiers?: IneligibleTier[] | null;
    cloudaicompanionProject?: string | null;
    paidTier?: GeminiUserTier | null;
}
/**
 * GeminiUserTier reflects the structure received from the CodeAssist when calling LoadCodeAssist.
 */
export interface GeminiUserTier {
    id?: UserTierId;
    name?: string;
    description?: string;
    userDefinedCloudaicompanionProject?: boolean | null;
    isDefault?: boolean;
    privacyNotice?: PrivacyNotice;
    hasAcceptedTos?: boolean;
    hasOnboardedPreviously?: boolean;
    /** Available AI credits for this tier (e.g., Google One AI credits) */
    availableCredits?: AvailableCredits[];
}
/**
 * Includes information specifying the reasons for a user's ineligibility for a specific tier.
 * @param reasonCode mnemonic code representing the reason for in-eligibility.
 * @param reasonMessage message to display to the user.
 * @param tierId id of the tier.
 * @param tierName name of the tier.
 */
export interface IneligibleTier {
    reasonCode?: IneligibleTierReasonCode;
    reasonMessage?: string;
    tierId?: UserTierId;
    tierName?: string;
    validationErrorMessage?: string;
    validationUrl?: string;
    validationUrlLinkText?: string;
    validationLearnMoreUrl?: string;
    validationLearnMoreLinkText?: string;
}
/**
 * List of predefined reason codes when a tier is blocked from a specific tier.
 * https://source.corp.google.com/piper///depot/google3/google/internal/cloud/code/v1internal/cloudcode.proto;l=378
 */
export declare enum IneligibleTierReasonCode {
    DASHER_USER = "DASHER_USER",
    INELIGIBLE_ACCOUNT = "INELIGIBLE_ACCOUNT",
    NON_USER_ACCOUNT = "NON_USER_ACCOUNT",
    RESTRICTED_AGE = "RESTRICTED_AGE",
    RESTRICTED_NETWORK = "RESTRICTED_NETWORK",
    UNKNOWN = "UNKNOWN",
    UNKNOWN_LOCATION = "UNKNOWN_LOCATION",
    UNSUPPORTED_LOCATION = "UNSUPPORTED_LOCATION",
    VALIDATION_REQUIRED = "VALIDATION_REQUIRED"
}
/**
 * UserTierId represents IDs returned from the Cloud Code Private API representing a user's tier
 *
 * http://google3/cloud/developer_experience/codeassist/shared/usertier/tiers.go
 * This is a subset of all available tiers. Since the source list is frequently updated,
 * only add a tierId here if specific client-side handling is required.
 */
export declare const UserTierId: {
    readonly FREE: "free-tier";
    readonly LEGACY: "legacy-tier";
    readonly STANDARD: "standard-tier";
};
export type UserTierId = (typeof UserTierId)[keyof typeof UserTierId] | string;
/**
 * PrivacyNotice reflects the structure received from the CodeAssist in regards to a tier
 * privacy notice.
 */
export interface PrivacyNotice {
    showNotice?: boolean;
    noticeText?: string;
}
/**
 * Proto signature of OnboardUserRequest as payload to OnboardUser call
 */
export interface OnboardUserRequest {
    tierId: string | undefined;
    cloudaicompanionProject: string | undefined;
    metadata: ClientMetadata | undefined;
}
/**
 * Represents LongRunningOperation proto
 * http://google3/google/longrunning/operations.proto;rcl=698857719;l=107
 */
export interface LongRunningOperationResponse {
    name?: string;
    done?: boolean;
    response?: OnboardUserResponse;
}
/**
 * Represents OnboardUserResponse proto
 * http://google3/google/internal/cloud/code/v1internal/cloudcode.proto;l=215
 */
export interface OnboardUserResponse {
    cloudaicompanionProject?: {
        id?: string;
        name?: string;
    };
}
/**
 * Status code of user license status
 * it does not strictly correspond to the proto
 * Error value is an additional value assigned to error responses from OnboardUser
 */
export declare enum OnboardUserStatusCode {
    Default = "DEFAULT",
    Notice = "NOTICE",
    Warning = "WARNING",
    Error = "ERROR"
}
/**
 * Status of user onboarded to gemini
 */
export interface OnboardUserStatus {
    statusCode: OnboardUserStatusCode;
    displayMessage: string;
    helpLink: HelpLinkUrl | undefined;
}
export interface HelpLinkUrl {
    description: string;
    url: string;
}
export interface SetCodeAssistGlobalUserSettingRequest {
    cloudaicompanionProject?: string;
    freeTierDataCollectionOptin?: boolean;
}
export interface CodeAssistGlobalUserSettingResponse {
    cloudaicompanionProject?: string;
    freeTierDataCollectionOptin?: boolean;
}
/**
 * Relevant fields that can be returned from a Google RPC response
 */
export interface GoogleRpcResponse {
    error?: {
        details?: GoogleRpcErrorInfo[];
    };
}
/**
 * Relevant fields that can be returned in the details of an error returned from GoogleRPCs
 */
interface GoogleRpcErrorInfo {
    reason?: string;
}
export interface RetrieveUserQuotaRequest {
    project: string;
    userAgent?: string;
}
export interface BucketInfo {
    remainingAmount?: string;
    remainingFraction?: number;
    resetTime?: string;
    tokenType?: string;
    modelId?: string;
}
export interface RetrieveUserQuotaResponse {
    buckets?: BucketInfo[];
}
export interface RecordCodeAssistMetricsRequest {
    project: string;
    requestId?: string;
    metadata?: ClientMetadata;
    metrics?: CodeAssistMetric[];
}
export interface CodeAssistMetric {
    timestamp?: string;
    metricMetadata?: Map<string, string>;
    conversationOffered?: ConversationOffered;
    conversationInteraction?: ConversationInteraction;
}
export declare enum ConversationInteractionInteraction {
    UNKNOWN = 0,
    THUMBSUP = 1,
    THUMBSDOWN = 2,
    COPY = 3,
    INSERT = 4,
    ACCEPT_CODE_BLOCK = 5,
    ACCEPT_ALL = 6,
    ACCEPT_FILE = 7,
    DIFF = 8,
    ACCEPT_RANGE = 9
}
export declare enum ActionStatus {
    ACTION_STATUS_UNSPECIFIED = 0,
    ACTION_STATUS_NO_ERROR = 1,
    ACTION_STATUS_ERROR_UNKNOWN = 2,
    ACTION_STATUS_CANCELLED = 3,
    ACTION_STATUS_EMPTY = 4
}
export declare enum InitiationMethod {
    INITIATION_METHOD_UNSPECIFIED = 0,
    TAB = 1,
    COMMAND = 2,
    AGENT = 3
}
export interface ConversationOffered {
    citationCount?: string;
    includedCode?: boolean;
    status?: ActionStatus;
    traceId?: string;
    streamingLatency?: StreamingLatency;
    isAgentic?: boolean;
    initiationMethod?: InitiationMethod;
}
export interface StreamingLatency {
    firstMessageLatency?: string;
    totalLatency?: string;
}
export interface ConversationInteraction {
    traceId: string;
    status?: ActionStatus;
    interaction?: ConversationInteractionInteraction;
    acceptedLines?: string;
    removedLines?: string;
    language?: string;
    isAgentic?: boolean;
}
export interface FetchAdminControlsRequest {
    project: string;
}
export type FetchAdminControlsResponse = z.infer<typeof FetchAdminControlsResponseSchema>;
export declare const McpConfigDefinitionSchema: z.ZodObject<{
    mcpServers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        url: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodEnum<["sse", "http"]>>;
        trust: z.ZodOptional<z.ZodBoolean>;
        includeTools: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        excludeTools: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        type?: "http" | "sse" | undefined;
        url?: string | undefined;
        trust?: boolean | undefined;
        includeTools?: string[] | undefined;
        excludeTools?: string[] | undefined;
    }, {
        type?: "http" | "sse" | undefined;
        url?: string | undefined;
        trust?: boolean | undefined;
        includeTools?: string[] | undefined;
        excludeTools?: string[] | undefined;
    }>>>;
}, "strip", z.ZodTypeAny, {
    mcpServers?: Record<string, {
        type?: "http" | "sse" | undefined;
        url?: string | undefined;
        trust?: boolean | undefined;
        includeTools?: string[] | undefined;
        excludeTools?: string[] | undefined;
    }> | undefined;
}, {
    mcpServers?: Record<string, {
        type?: "http" | "sse" | undefined;
        url?: string | undefined;
        trust?: boolean | undefined;
        includeTools?: string[] | undefined;
        excludeTools?: string[] | undefined;
    }> | undefined;
}>;
export type McpConfigDefinition = z.infer<typeof McpConfigDefinitionSchema>;
export declare const AdminControlsSettingsSchema: z.ZodObject<{
    strictModeDisabled: z.ZodOptional<z.ZodBoolean>;
    mcpSetting: z.ZodOptional<z.ZodObject<{
        mcpEnabled: z.ZodOptional<z.ZodBoolean>;
        mcpConfig: z.ZodOptional<z.ZodObject<{
            mcpServers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
                url: z.ZodOptional<z.ZodString>;
                type: z.ZodOptional<z.ZodEnum<["sse", "http"]>>;
                trust: z.ZodOptional<z.ZodBoolean>;
                includeTools: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
                excludeTools: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            }, "strip", z.ZodTypeAny, {
                type?: "http" | "sse" | undefined;
                url?: string | undefined;
                trust?: boolean | undefined;
                includeTools?: string[] | undefined;
                excludeTools?: string[] | undefined;
            }, {
                type?: "http" | "sse" | undefined;
                url?: string | undefined;
                trust?: boolean | undefined;
                includeTools?: string[] | undefined;
                excludeTools?: string[] | undefined;
            }>>>;
        }, "strip", z.ZodTypeAny, {
            mcpServers?: Record<string, {
                type?: "http" | "sse" | undefined;
                url?: string | undefined;
                trust?: boolean | undefined;
                includeTools?: string[] | undefined;
                excludeTools?: string[] | undefined;
            }> | undefined;
        }, {
            mcpServers?: Record<string, {
                type?: "http" | "sse" | undefined;
                url?: string | undefined;
                trust?: boolean | undefined;
                includeTools?: string[] | undefined;
                excludeTools?: string[] | undefined;
            }> | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        mcpEnabled?: boolean | undefined;
        mcpConfig?: {
            mcpServers?: Record<string, {
                type?: "http" | "sse" | undefined;
                url?: string | undefined;
                trust?: boolean | undefined;
                includeTools?: string[] | undefined;
                excludeTools?: string[] | undefined;
            }> | undefined;
        } | undefined;
    }, {
        mcpEnabled?: boolean | undefined;
        mcpConfig?: {
            mcpServers?: Record<string, {
                type?: "http" | "sse" | undefined;
                url?: string | undefined;
                trust?: boolean | undefined;
                includeTools?: string[] | undefined;
                excludeTools?: string[] | undefined;
            }> | undefined;
        } | undefined;
    }>>;
    cliFeatureSetting: z.ZodOptional<z.ZodObject<{
        extensionsSetting: z.ZodOptional<z.ZodObject<{
            extensionsEnabled: z.ZodOptional<z.ZodBoolean>;
        }, "strip", z.ZodTypeAny, {
            extensionsEnabled?: boolean | undefined;
        }, {
            extensionsEnabled?: boolean | undefined;
        }>>;
        unmanagedCapabilitiesEnabled: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        extensionsSetting?: {
            extensionsEnabled?: boolean | undefined;
        } | undefined;
        unmanagedCapabilitiesEnabled?: boolean | undefined;
    }, {
        extensionsSetting?: {
            extensionsEnabled?: boolean | undefined;
        } | undefined;
        unmanagedCapabilitiesEnabled?: boolean | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    strictModeDisabled?: boolean | undefined;
    mcpSetting?: {
        mcpEnabled?: boolean | undefined;
        mcpConfig?: {
            mcpServers?: Record<string, {
                type?: "http" | "sse" | undefined;
                url?: string | undefined;
                trust?: boolean | undefined;
                includeTools?: string[] | undefined;
                excludeTools?: string[] | undefined;
            }> | undefined;
        } | undefined;
    } | undefined;
    cliFeatureSetting?: {
        extensionsSetting?: {
            extensionsEnabled?: boolean | undefined;
        } | undefined;
        unmanagedCapabilitiesEnabled?: boolean | undefined;
    } | undefined;
}, {
    strictModeDisabled?: boolean | undefined;
    mcpSetting?: {
        mcpEnabled?: boolean | undefined;
        mcpConfig?: {
            mcpServers?: Record<string, {
                type?: "http" | "sse" | undefined;
                url?: string | undefined;
                trust?: boolean | undefined;
                includeTools?: string[] | undefined;
                excludeTools?: string[] | undefined;
            }> | undefined;
        } | undefined;
    } | undefined;
    cliFeatureSetting?: {
        extensionsSetting?: {
            extensionsEnabled?: boolean | undefined;
        } | undefined;
        unmanagedCapabilitiesEnabled?: boolean | undefined;
    } | undefined;
}>;
export type AdminControlsSettings = z.infer<typeof AdminControlsSettingsSchema>;
export declare const FetchAdminControlsResponseSchema: z.ZodObject<{
    secureModeEnabled: z.ZodOptional<z.ZodBoolean>;
    strictModeDisabled: z.ZodOptional<z.ZodBoolean>;
    mcpSetting: z.ZodOptional<z.ZodObject<{
        mcpEnabled: z.ZodOptional<z.ZodBoolean>;
        mcpConfigJson: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        mcpEnabled?: boolean | undefined;
        mcpConfigJson?: string | undefined;
    }, {
        mcpEnabled?: boolean | undefined;
        mcpConfigJson?: string | undefined;
    }>>;
    cliFeatureSetting: z.ZodOptional<z.ZodObject<{
        extensionsSetting: z.ZodOptional<z.ZodObject<{
            extensionsEnabled: z.ZodOptional<z.ZodBoolean>;
        }, "strip", z.ZodTypeAny, {
            extensionsEnabled?: boolean | undefined;
        }, {
            extensionsEnabled?: boolean | undefined;
        }>>;
        unmanagedCapabilitiesEnabled: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        extensionsSetting?: {
            extensionsEnabled?: boolean | undefined;
        } | undefined;
        unmanagedCapabilitiesEnabled?: boolean | undefined;
    }, {
        extensionsSetting?: {
            extensionsEnabled?: boolean | undefined;
        } | undefined;
        unmanagedCapabilitiesEnabled?: boolean | undefined;
    }>>;
    adminControlsApplicable: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    secureModeEnabled?: boolean | undefined;
    strictModeDisabled?: boolean | undefined;
    mcpSetting?: {
        mcpEnabled?: boolean | undefined;
        mcpConfigJson?: string | undefined;
    } | undefined;
    cliFeatureSetting?: {
        extensionsSetting?: {
            extensionsEnabled?: boolean | undefined;
        } | undefined;
        unmanagedCapabilitiesEnabled?: boolean | undefined;
    } | undefined;
    adminControlsApplicable?: boolean | undefined;
}, {
    secureModeEnabled?: boolean | undefined;
    strictModeDisabled?: boolean | undefined;
    mcpSetting?: {
        mcpEnabled?: boolean | undefined;
        mcpConfigJson?: string | undefined;
    } | undefined;
    cliFeatureSetting?: {
        extensionsSetting?: {
            extensionsEnabled?: boolean | undefined;
        } | undefined;
        unmanagedCapabilitiesEnabled?: boolean | undefined;
    } | undefined;
    adminControlsApplicable?: boolean | undefined;
}>;
export {};
