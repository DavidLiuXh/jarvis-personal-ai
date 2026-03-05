/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FakeContentGenerator, } from './fakeContentGenerator.js';
import { promises } from 'node:fs';
import { GenerateContentResponse, } from '@google/genai';
import { LlmRole } from '../telemetry/types.js';
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        promises: {
            ...actual.promises,
            readFile: vi.fn(),
        },
    };
});
const mockReadFile = vi.mocked(promises.readFile);
describe('FakeContentGenerator', () => {
    const fakeGenerateContentResponse = {
        method: 'generateContent',
        response: {
            candidates: [
                { content: { parts: [{ text: 'response1' }], role: 'model' } },
            ],
        },
    };
    const fakeGenerateContentStreamResponse = {
        method: 'generateContentStream',
        response: [
            {
                candidates: [
                    { content: { parts: [{ text: 'chunk1' }], role: 'model' } },
                ],
            },
            {
                candidates: [
                    { content: { parts: [{ text: 'chunk2' }], role: 'model' } },
                ],
            },
        ],
    };
    const fakeCountTokensResponse = {
        method: 'countTokens',
        response: { totalTokens: 10 },
    };
    const fakeEmbedContentResponse = {
        method: 'embedContent',
        response: {
            embeddings: [{ values: [1, 2, 3] }],
        },
    };
    beforeEach(() => {
        vi.resetAllMocks();
    });
    it('should return responses for generateContent', async () => {
        const generator = new FakeContentGenerator([fakeGenerateContentResponse]);
        const response = await generator.generateContent({}, 'id', LlmRole.MAIN);
        expect(response).instanceOf(GenerateContentResponse);
        expect(response).toEqual(fakeGenerateContentResponse.response);
    });
    it('should return responses for generateContentStream', async () => {
        const generator = new FakeContentGenerator([
            fakeGenerateContentStreamResponse,
        ]);
        const stream = await generator.generateContentStream({}, 'id', LlmRole.MAIN);
        const responses = [];
        for await (const response of stream) {
            expect(response).instanceOf(GenerateContentResponse);
            responses.push(response);
        }
        expect(responses).toEqual(fakeGenerateContentStreamResponse.response);
    });
    it('should return responses for countTokens', async () => {
        const generator = new FakeContentGenerator([fakeCountTokensResponse]);
        const response = await generator.countTokens({});
        expect(response).toEqual(fakeCountTokensResponse.response);
    });
    it('should return responses for embedContent', async () => {
        const generator = new FakeContentGenerator([fakeEmbedContentResponse]);
        const response = await generator.embedContent({});
        expect(response).toEqual(fakeEmbedContentResponse.response);
    });
    it('should handle a mixture of calls', async () => {
        const fakeResponses = [
            fakeGenerateContentResponse,
            fakeGenerateContentStreamResponse,
            fakeCountTokensResponse,
            fakeEmbedContentResponse,
        ];
        const generator = new FakeContentGenerator(fakeResponses);
        for (const fakeResponse of fakeResponses) {
            const response = await generator[fakeResponse.method]({}, '', LlmRole.MAIN);
            if (fakeResponse.method === 'generateContentStream') {
                const responses = [];
                for await (const item of response) {
                    expect(item).instanceOf(GenerateContentResponse);
                    responses.push(item);
                }
                expect(responses).toEqual(fakeResponse.response);
            }
            else {
                expect(response).toEqual(fakeResponse.response);
            }
        }
    });
    it('should throw error when no more responses', async () => {
        const generator = new FakeContentGenerator([fakeGenerateContentResponse]);
        await generator.generateContent({}, 'id', LlmRole.MAIN);
        await expect(generator.embedContent({})).rejects.toThrowError('No more mock responses for embedContent');
        await expect(generator.countTokens({})).rejects.toThrowError('No more mock responses for countTokens');
        await expect(generator.generateContentStream({}, 'id', LlmRole.MAIN)).rejects.toThrow('No more mock responses for generateContentStream');
        await expect(generator.generateContent({}, 'id', LlmRole.MAIN)).rejects.toThrowError('No more mock responses for generateContent');
    });
    describe('fromFile', () => {
        it('should create a generator from a file', async () => {
            const fileContent = JSON.stringify(fakeGenerateContentResponse) + '\n';
            mockReadFile.mockResolvedValue(fileContent);
            const generator = await FakeContentGenerator.fromFile('fake-path.json');
            const response = await generator.generateContent({}, 'id', LlmRole.MAIN);
            expect(response).toEqual(fakeGenerateContentResponse.response);
        });
    });
});
//# sourceMappingURL=fakeContentGenerator.test.js.map