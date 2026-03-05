/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { appendFileSync } from 'node:fs';
import { safeJsonStringify } from '../utils/safeJsonStringify.js';
// A ContentGenerator that wraps another content generator and records all the
// responses, with the ability to write them out to a file. These files are
// intended to be consumed later on by a FakeContentGenerator, given the
// `--fake-responses` CLI argument.
//
// Note that only the "interesting" bits of the responses are actually kept.
export class RecordingContentGenerator {
    realGenerator;
    filePath;
    constructor(realGenerator, filePath) {
        this.realGenerator = realGenerator;
        this.filePath = filePath;
    }
    get userTier() {
        return this.realGenerator.userTier;
    }
    get userTierName() {
        return this.realGenerator.userTierName;
    }
    async generateContent(request, userPromptId, role) {
        const response = await this.realGenerator.generateContent(request, userPromptId, role);
        const recordedResponse = {
            method: 'generateContent',
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            response: {
                candidates: response.candidates,
                usageMetadata: response.usageMetadata,
            },
        };
        appendFileSync(this.filePath, `${safeJsonStringify(recordedResponse)}\n`);
        return response;
    }
    async generateContentStream(request, userPromptId, role) {
        const recordedResponse = {
            method: 'generateContentStream',
            response: [],
        };
        const realResponses = await this.realGenerator.generateContentStream(request, userPromptId, role);
        async function* stream(filePath) {
            for await (const response of realResponses) {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
                recordedResponse.response.push({
                    candidates: response.candidates,
                    usageMetadata: response.usageMetadata,
                });
                yield response;
            }
            appendFileSync(filePath, `${safeJsonStringify(recordedResponse)}\n`);
        }
        return Promise.resolve(stream(this.filePath));
    }
    async countTokens(request) {
        const response = await this.realGenerator.countTokens(request);
        const recordedResponse = {
            method: 'countTokens',
            response: {
                totalTokens: response.totalTokens,
                cachedContentTokenCount: response.cachedContentTokenCount,
            },
        };
        appendFileSync(this.filePath, `${safeJsonStringify(recordedResponse)}\n`);
        return response;
    }
    async embedContent(request) {
        const response = await this.realGenerator.embedContent(request);
        const recordedResponse = {
            method: 'embedContent',
            response: {
                embeddings: response.embeddings,
                metadata: response.metadata,
            },
        };
        appendFileSync(this.filePath, `${safeJsonStringify(recordedResponse)}\n`);
        return response;
    }
}
//# sourceMappingURL=recordingContentGenerator.js.map