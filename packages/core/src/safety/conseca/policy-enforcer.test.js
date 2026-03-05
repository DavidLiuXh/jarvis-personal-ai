/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enforcePolicy } from './policy-enforcer.js';
import { SafetyCheckDecision } from '../protocol.js';
import { LlmRole } from '../../telemetry/index.js';
describe('policy_enforcer', () => {
    let mockConfig;
    let mockContentGenerator;
    beforeEach(() => {
        vi.clearAllMocks();
        mockContentGenerator = {
            generateContent: vi.fn(),
        };
        mockConfig = {
            getContentGenerator: vi.fn().mockReturnValue(mockContentGenerator),
        };
    });
    it('should return ALLOW when content generator returns ALLOW', async () => {
        mockContentGenerator.generateContent = vi.fn().mockResolvedValue({
            candidates: [
                {
                    content: {
                        parts: [
                            { text: JSON.stringify({ decision: 'allow', reason: 'Safe' }) },
                        ],
                    },
                },
            ],
        });
        const toolCall = { name: 'testTool', args: {} };
        const policy = {
            testTool: {
                permissions: SafetyCheckDecision.ALLOW,
                constraints: 'None',
                rationale: 'Test',
            },
        };
        const result = await enforcePolicy(policy, toolCall, mockConfig);
        expect(mockConfig.getContentGenerator).toHaveBeenCalled();
        expect(mockContentGenerator.generateContent).toHaveBeenCalledWith(expect.objectContaining({
            model: expect.any(String),
            config: expect.objectContaining({
                responseMimeType: 'application/json',
                responseSchema: expect.any(Object),
            }),
            contents: expect.arrayContaining([
                expect.objectContaining({
                    role: 'user',
                    parts: expect.arrayContaining([
                        expect.objectContaining({
                            text: expect.stringContaining('Security Policy:'),
                        }),
                    ]),
                }),
            ]),
        }), 'conseca-policy-enforcement', LlmRole.SUBAGENT);
        expect(result.decision).toBe(SafetyCheckDecision.ALLOW);
    });
    it('should handle missing content generator gracefully (error case)', async () => {
        vi.mocked(mockConfig.getContentGenerator).mockReturnValue(undefined);
        const toolCall = { name: 'testTool', args: {} };
        const policy = {
            testTool: {
                permissions: SafetyCheckDecision.ALLOW,
                constraints: 'None',
                rationale: 'Test',
            },
        };
        const result = await enforcePolicy(policy, toolCall, mockConfig);
        expect(result.decision).toBe(SafetyCheckDecision.ALLOW);
    });
    it('should ALLOW if tool name is missing with the reason and error as tool name is missing', async () => {
        const toolCall = { args: {} };
        const policy = {};
        const result = await enforcePolicy(policy, toolCall, mockConfig);
        expect(result.decision).toBe(SafetyCheckDecision.ALLOW);
        expect(result.reason).toBe('Tool name is missing');
        if (result.decision === SafetyCheckDecision.ALLOW) {
            expect(result.error).toBe('Tool name is missing');
        }
    });
    it('should handle empty policy by checking with LLM (fail-open/check behavior)', async () => {
        // Even if policy is empty for the tool, we currently send it to LLM.
        // The LLM might ALLOW or DENY based on its own judgment of "no policy".
        // We simulate the LLM allowing the action to match the current fail-open strategy.
        mockContentGenerator.generateContent = vi.fn().mockResolvedValue({
            candidates: [
                {
                    content: {
                        parts: [
                            {
                                text: JSON.stringify({
                                    decision: 'allow',
                                    reason: 'No restrictions',
                                }),
                            },
                        ],
                    },
                },
            ],
        });
        const toolCall = { name: 'unknownTool', args: {} };
        const policy = {}; // Empty policy
        const result = await enforcePolicy(policy, toolCall, mockConfig);
        expect(result.decision).toBe(SafetyCheckDecision.ALLOW);
        expect(mockContentGenerator.generateContent).toHaveBeenCalled();
        if (result.decision === SafetyCheckDecision.ALLOW) {
            expect(result.error).toBeUndefined();
        }
    });
    it('should handle malformed JSON response from LLM by failing open (ALLOW)', async () => {
        mockContentGenerator.generateContent = vi.fn().mockResolvedValue({
            candidates: [
                {
                    content: {
                        parts: [{ text: 'This is not JSON' }],
                    },
                },
            ],
        });
        const toolCall = { name: 'testTool', args: {} };
        const policy = {
            testTool: {
                permissions: SafetyCheckDecision.ALLOW,
                constraints: 'None',
                rationale: 'Test',
            },
        };
        const result = await enforcePolicy(policy, toolCall, mockConfig);
        expect(result.decision).toBe(SafetyCheckDecision.ALLOW);
        expect(result.reason).toContain('JSON Parse Error');
        if (result.decision === SafetyCheckDecision.ALLOW) {
            expect(result.error).toContain('JSON Parse Error');
        }
    });
});
//# sourceMappingURL=policy-enforcer.test.js.map