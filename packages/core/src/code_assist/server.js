/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { UserTierId, } from './types.js';
import * as readline from 'node:readline';
import { Readable } from 'node:stream';
import { G1_CREDIT_TYPE, getG1CreditBalance, isOverageEligibleModel, shouldAutoUseCredits, } from '../billing/billing.js';
import { logBillingEvent, logInvalidChunk } from '../telemetry/loggers.js';
import { CreditsUsedEvent } from '../telemetry/billingEvents.js';
import { fromCountTokenResponse, fromGenerateContentResponse, toCountTokenRequest, toGenerateContentRequest, } from './converter.js';
import { formatProtoJsonDuration, recordConversationOffered, } from './telemetry.js';
import { getClientMetadata } from './experiments/client_metadata.js';
import { InvalidChunkEvent } from '../telemetry/types.js';
export const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
export const CODE_ASSIST_API_VERSION = 'v1internal';
const GENERATE_CONTENT_RETRY_DELAY_IN_MILLISECONDS = 1000;
export class CodeAssistServer {
    client;
    projectId;
    httpOptions;
    sessionId;
    userTier;
    userTierName;
    paidTier;
    config;
    constructor(client, projectId, httpOptions = {}, sessionId, userTier, userTierName, paidTier, config) {
        this.client = client;
        this.projectId = projectId;
        this.httpOptions = httpOptions;
        this.sessionId = sessionId;
        this.userTier = userTier;
        this.userTierName = userTierName;
        this.paidTier = paidTier;
        this.config = config;
    }
    async generateContentStream(req, userPromptId, 
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    role) {
        const autoUse = this.config
            ? shouldAutoUseCredits(this.config.getBillingSettings().overageStrategy, getG1CreditBalance(this.paidTier))
            : false;
        const modelIsEligible = isOverageEligibleModel(req.model);
        const shouldEnableCredits = modelIsEligible && autoUse;
        const enabledCreditTypes = shouldEnableCredits
            ? [G1_CREDIT_TYPE]
            : undefined;
        const responses = await this.requestStreamingPost('streamGenerateContent', toGenerateContentRequest(req, userPromptId, this.projectId, this.sessionId, enabledCreditTypes), req.config?.abortSignal);
        const streamingLatency = {};
        const start = Date.now();
        let isFirst = true;
        return (async function* (server) {
            let totalConsumed = 0;
            let lastRemaining = 0;
            for await (const response of responses) {
                if (isFirst) {
                    streamingLatency.firstMessageLatency = formatProtoJsonDuration(Date.now() - start);
                    isFirst = false;
                }
                streamingLatency.totalLatency = formatProtoJsonDuration(Date.now() - start);
                const translatedResponse = fromGenerateContentResponse(response);
                await recordConversationOffered(server, response.traceId, translatedResponse, streamingLatency, req.config?.abortSignal);
                if (response.consumedCredits) {
                    for (const credit of response.consumedCredits) {
                        if (credit.creditType === G1_CREDIT_TYPE && credit.creditAmount) {
                            totalConsumed += parseInt(credit.creditAmount, 10) || 0;
                        }
                    }
                }
                if (response.remainingCredits) {
                    // Sum all G1 credit entries for consistency with getG1CreditBalance
                    lastRemaining = response.remainingCredits.reduce((sum, credit) => {
                        if (credit.creditType === G1_CREDIT_TYPE && credit.creditAmount) {
                            return sum + (parseInt(credit.creditAmount, 10) || 0);
                        }
                        return sum;
                    }, 0);
                    server.updateCredits(response.remainingCredits);
                }
                yield translatedResponse;
            }
            // Emit credits used telemetry after the stream completes
            if (totalConsumed > 0 && server.config) {
                logBillingEvent(server.config, new CreditsUsedEvent(req.model ?? 'unknown', totalConsumed, lastRemaining));
            }
        })(this);
    }
    async generateContent(req, userPromptId, 
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    role) {
        const start = Date.now();
        const response = await this.requestPost('generateContent', toGenerateContentRequest(req, userPromptId, this.projectId, this.sessionId, undefined), req.config?.abortSignal, GENERATE_CONTENT_RETRY_DELAY_IN_MILLISECONDS);
        const duration = formatProtoJsonDuration(Date.now() - start);
        const streamingLatency = {
            totalLatency: duration,
            firstMessageLatency: duration,
        };
        const translatedResponse = fromGenerateContentResponse(response);
        await recordConversationOffered(this, response.traceId, translatedResponse, streamingLatency, req.config?.abortSignal);
        if (response.remainingCredits) {
            this.updateCredits(response.remainingCredits);
        }
        return translatedResponse;
    }
    updateCredits(remainingCredits) {
        if (!this.paidTier) {
            return;
        }
        // Replace the G1 credits entries with the latest remaining amounts.
        // Non-G1 credits are preserved as-is.
        const nonG1Credits = (this.paidTier.availableCredits ?? []).filter((c) => c.creditType !== G1_CREDIT_TYPE);
        const updatedG1Credits = remainingCredits.filter((c) => c.creditType === G1_CREDIT_TYPE);
        this.paidTier.availableCredits = [...nonG1Credits, ...updatedG1Credits];
    }
    async onboardUser(req) {
        return this.requestPost('onboardUser', req);
    }
    async getOperation(name) {
        return this.requestGetOperation(name);
    }
    async loadCodeAssist(req) {
        try {
            return await this.requestPost('loadCodeAssist', req);
        }
        catch (e) {
            if (isVpcScAffectedUser(e)) {
                return {
                    currentTier: { id: UserTierId.STANDARD },
                };
            }
            else {
                throw e;
            }
        }
    }
    async refreshAvailableCredits() {
        if (!this.paidTier) {
            return;
        }
        const res = await this.loadCodeAssist({
            cloudaicompanionProject: this.projectId,
            metadata: {
                ideType: 'IDE_UNSPECIFIED',
                platform: 'PLATFORM_UNSPECIFIED',
                pluginType: 'GEMINI',
                duetProject: this.projectId,
            },
            mode: 'HEALTH_CHECK',
        });
        if (res.paidTier?.availableCredits) {
            this.paidTier.availableCredits = res.paidTier.availableCredits;
        }
    }
    async fetchAdminControls(req) {
        return this.requestPost('fetchAdminControls', req);
    }
    async getCodeAssistGlobalUserSetting() {
        return this.requestGet('getCodeAssistGlobalUserSetting');
    }
    async setCodeAssistGlobalUserSetting(req) {
        return this.requestPost('setCodeAssistGlobalUserSetting', req);
    }
    async countTokens(req) {
        const resp = await this.requestPost('countTokens', toCountTokenRequest(req));
        return fromCountTokenResponse(resp);
    }
    async embedContent(_req) {
        throw Error();
    }
    async listExperiments(metadata) {
        if (!this.projectId) {
            throw new Error('projectId is not defined for CodeAssistServer.');
        }
        const projectId = this.projectId;
        const req = {
            project: projectId,
            metadata: { ...metadata, duetProject: projectId },
        };
        return this.requestPost('listExperiments', req);
    }
    async retrieveUserQuota(req) {
        return this.requestPost('retrieveUserQuota', req);
    }
    async recordConversationOffered(conversationOffered) {
        if (!this.projectId) {
            return;
        }
        await this.recordCodeAssistMetrics({
            project: this.projectId,
            metadata: await getClientMetadata(),
            metrics: [{ conversationOffered, timestamp: new Date().toISOString() }],
        });
    }
    async recordConversationInteraction(interaction) {
        if (!this.projectId) {
            return;
        }
        await this.recordCodeAssistMetrics({
            project: this.projectId,
            metadata: await getClientMetadata(),
            metrics: [
                {
                    conversationInteraction: interaction,
                    timestamp: new Date().toISOString(),
                },
            ],
        });
    }
    async recordCodeAssistMetrics(request) {
        return this.requestPost('recordCodeAssistMetrics', request);
    }
    async requestPost(method, req, signal, retryDelay = 100) {
        const res = await this.client.request({
            url: this.getMethodUrl(method),
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...this.httpOptions.headers,
            },
            responseType: 'json',
            body: JSON.stringify(req),
            signal,
            retryConfig: {
                retryDelay,
                retry: 3,
                noResponseRetries: 3,
                statusCodesToRetry: [
                    [429, 429],
                    [499, 499],
                    [500, 599],
                ],
            },
        });
        return res.data;
    }
    async makeGetRequest(url, signal) {
        const res = await this.client.request({
            url,
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                ...this.httpOptions.headers,
            },
            responseType: 'json',
            signal,
        });
        return res.data;
    }
    async requestGet(method, signal) {
        return this.makeGetRequest(this.getMethodUrl(method), signal);
    }
    async requestGetOperation(name, signal) {
        return this.makeGetRequest(this.getOperationUrl(name), signal);
    }
    async requestStreamingPost(method, req, signal) {
        const res = await this.client.request({
            url: this.getMethodUrl(method),
            method: 'POST',
            params: {
                alt: 'sse',
            },
            headers: {
                'Content-Type': 'application/json',
                ...this.httpOptions.headers,
            },
            responseType: 'stream',
            body: JSON.stringify(req),
            signal,
            retry: false,
        });
        return (async function* (server) {
            const rl = readline.createInterface({
                input: Readable.from(res.data),
                crlfDelay: Infinity, // Recognizes '\r\n' and '\n' as line breaks
            });
            let bufferedLines = [];
            for await (const line of rl) {
                if (line.startsWith('data: ')) {
                    bufferedLines.push(line.slice(6).trim());
                }
                else if (line === '') {
                    if (bufferedLines.length === 0) {
                        continue; // no data to yield
                    }
                    const chunk = bufferedLines.join('\n');
                    try {
                        yield JSON.parse(chunk);
                    }
                    catch (_e) {
                        if (server.config) {
                            logInvalidChunk(server.config, 
                            // Don't include the chunk content in the log for security/privacy reasons.
                            new InvalidChunkEvent('Malformed JSON chunk'));
                        }
                    }
                    bufferedLines = []; // Reset the buffer after yielding
                }
                // Ignore other lines like comments or id fields
            }
        })(this);
    }
    getBaseUrl() {
        const endpoint = process.env['CODE_ASSIST_ENDPOINT'] ?? CODE_ASSIST_ENDPOINT;
        const version = process.env['CODE_ASSIST_API_VERSION'] || CODE_ASSIST_API_VERSION;
        return `${endpoint}/${version}`;
    }
    getMethodUrl(method) {
        return `${this.getBaseUrl()}:${method}`;
    }
    getOperationUrl(name) {
        return `${this.getBaseUrl()}/${name}`;
    }
}
function isVpcScErrorResponse(error) {
    return (!!error &&
        typeof error === 'object' &&
        'response' in error &&
        !!error.response &&
        typeof error.response === 'object' &&
        'data' in error.response &&
        !!error.response.data &&
        typeof error.response.data === 'object' &&
        'error' in error.response.data &&
        !!error.response.data.error &&
        typeof error.response.data.error === 'object' &&
        'details' in error.response.data.error &&
        Array.isArray(error.response.data.error.details));
}
function isVpcScAffectedUser(error) {
    if (isVpcScErrorResponse(error)) {
        return error.response.data.error.details.some((detail) => detail &&
            typeof detail === 'object' &&
            'reason' in detail &&
            detail.reason === 'SECURITY_POLICY_VIOLATED');
    }
    return false;
}
//# sourceMappingURL=server.js.map