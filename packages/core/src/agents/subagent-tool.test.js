/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SubagentTool } from './subagent-tool.js';
import { SubagentToolWrapper } from './subagent-tool-wrapper.js';
import { Kind, } from '../tools/tools.js';
import { makeFakeConfig } from '../test-utils/config.js';
import { createMockMessageBus } from '../test-utils/mock-message-bus.js';
import { GeminiCliOperation, GEN_AI_AGENT_DESCRIPTION, GEN_AI_AGENT_NAME, } from '../telemetry/constants.js';
vi.mock('./subagent-tool-wrapper.js');
// Mock runInDevTraceSpan
const runInDevTraceSpan = vi.hoisted(() => vi.fn(async (opts, fn) => {
    const metadata = { attributes: opts.attributes || {} };
    return fn({
        metadata,
        endSpan: vi.fn(),
    });
}));
vi.mock('../telemetry/trace.js', () => ({
    runInDevTraceSpan,
}));
const MockSubagentToolWrapper = vi.mocked(SubagentToolWrapper);
const testDefinition = {
    kind: 'local',
    name: 'LocalAgent',
    description: 'A local agent.',
    inputConfig: { inputSchema: { type: 'object', properties: {} } },
    modelConfig: { model: 'test', generateContentConfig: {} },
    runConfig: { maxTimeMinutes: 1 },
    promptConfig: { systemPrompt: 'test' },
};
const testRemoteDefinition = {
    kind: 'remote',
    name: 'RemoteAgent',
    description: 'A remote agent.',
    inputConfig: {
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    },
    agentCardUrl: 'http://example.com/agent',
};
describe('SubAgentInvocation', () => {
    let mockConfig;
    let mockMessageBus;
    let mockInnerInvocation;
    beforeEach(() => {
        vi.clearAllMocks();
        mockConfig = makeFakeConfig();
        mockMessageBus = createMockMessageBus();
        mockInnerInvocation = {
            shouldConfirmExecute: vi.fn(),
            execute: vi.fn(),
            params: {},
            getDescription: vi.fn(),
            toolLocations: vi.fn(),
        };
        MockSubagentToolWrapper.prototype.build = vi
            .fn()
            .mockReturnValue(mockInnerInvocation);
    });
    it('should have Kind.Agent', () => {
        const tool = new SubagentTool(testDefinition, mockConfig, mockMessageBus);
        expect(tool.kind).toBe(Kind.Agent);
    });
    it('should delegate shouldConfirmExecute to the inner sub-invocation (local)', async () => {
        const tool = new SubagentTool(testDefinition, mockConfig, mockMessageBus);
        const params = {};
        // @ts-expect-error - accessing protected method for testing
        const invocation = tool.createInvocation(params, mockMessageBus);
        vi.mocked(mockInnerInvocation.shouldConfirmExecute).mockResolvedValue(false);
        const abortSignal = new AbortController().signal;
        const result = await invocation.shouldConfirmExecute(abortSignal);
        expect(result).toBe(false);
        expect(mockInnerInvocation.shouldConfirmExecute).toHaveBeenCalledWith(abortSignal);
        expect(MockSubagentToolWrapper).toHaveBeenCalledWith(testDefinition, mockConfig, mockMessageBus);
    });
    it('should return the correct description', () => {
        const tool = new SubagentTool(testDefinition, mockConfig, mockMessageBus);
        const params = {};
        // @ts-expect-error - accessing protected method for testing
        const invocation = tool.createInvocation(params, mockMessageBus);
        expect(invocation.getDescription()).toBe("Delegating to agent 'LocalAgent'");
    });
    it('should delegate shouldConfirmExecute to the inner sub-invocation (remote)', async () => {
        const tool = new SubagentTool(testRemoteDefinition, mockConfig, mockMessageBus);
        const params = { query: 'test' };
        // @ts-expect-error - accessing protected method for testing
        const invocation = tool.createInvocation(params, mockMessageBus);
        const confirmationDetails = {
            type: 'info',
            title: 'Confirm',
            prompt: 'Prompt',
            onConfirm: vi.fn(),
        };
        vi.mocked(mockInnerInvocation.shouldConfirmExecute).mockResolvedValue(confirmationDetails);
        const abortSignal = new AbortController().signal;
        const result = await invocation.shouldConfirmExecute(abortSignal);
        expect(result).toBe(confirmationDetails);
        expect(mockInnerInvocation.shouldConfirmExecute).toHaveBeenCalledWith(abortSignal);
        expect(MockSubagentToolWrapper).toHaveBeenCalledWith(testRemoteDefinition, mockConfig, mockMessageBus);
    });
    it('should delegate execute to the inner sub-invocation', async () => {
        const tool = new SubagentTool(testDefinition, mockConfig, mockMessageBus);
        const params = {};
        // @ts-expect-error - accessing protected method for testing
        const invocation = tool.createInvocation(params, mockMessageBus);
        const mockResult = {
            llmContent: 'success',
            returnDisplay: 'success',
        };
        vi.mocked(mockInnerInvocation.execute).mockResolvedValue(mockResult);
        const abortSignal = new AbortController().signal;
        const updateOutput = vi.fn();
        const result = await invocation.execute(abortSignal, updateOutput);
        expect(result).toBe(mockResult);
        expect(mockInnerInvocation.execute).toHaveBeenCalledWith(abortSignal, updateOutput);
        expect(runInDevTraceSpan).toHaveBeenCalledWith(expect.objectContaining({
            operation: GeminiCliOperation.AgentCall,
            attributes: expect.objectContaining({
                [GEN_AI_AGENT_NAME]: testDefinition.name,
                [GEN_AI_AGENT_DESCRIPTION]: testDefinition.description,
            }),
        }), expect.any(Function));
        // Verify metadata was set on the span
        const spanCallback = vi.mocked(runInDevTraceSpan).mock.calls[0][1];
        const mockMetadata = { input: undefined, output: undefined };
        const mockSpan = { metadata: mockMetadata, endSpan: vi.fn() };
        await spanCallback(mockSpan);
        expect(mockMetadata.input).toBe(params);
        expect(mockMetadata.output).toBe(mockResult);
    });
    describe('withUserHints', () => {
        it('should NOT modify query for local agents', async () => {
            mockConfig = makeFakeConfig({ modelSteering: true });
            mockConfig.userHintService.addUserHint('Test Hint');
            const tool = new SubagentTool(testDefinition, mockConfig, mockMessageBus);
            const params = { query: 'original query' };
            // @ts-expect-error - accessing private method for testing
            const invocation = tool.createInvocation(params, mockMessageBus);
            // @ts-expect-error - accessing private method for testing
            const hintedParams = invocation.withUserHints(params);
            expect(hintedParams.query).toBe('original query');
        });
        it('should NOT modify query for remote agents if model steering is disabled', async () => {
            mockConfig = makeFakeConfig({ modelSteering: false });
            mockConfig.userHintService.addUserHint('Test Hint');
            const tool = new SubagentTool(testRemoteDefinition, mockConfig, mockMessageBus);
            const params = { query: 'original query' };
            // @ts-expect-error - accessing private method for testing
            const invocation = tool.createInvocation(params, mockMessageBus);
            // @ts-expect-error - accessing private method for testing
            const hintedParams = invocation.withUserHints(params);
            expect(hintedParams.query).toBe('original query');
        });
        it('should NOT modify query for remote agents if there are no hints', async () => {
            mockConfig = makeFakeConfig({ modelSteering: true });
            const tool = new SubagentTool(testRemoteDefinition, mockConfig, mockMessageBus);
            const params = { query: 'original query' };
            // @ts-expect-error - accessing private method for testing
            const invocation = tool.createInvocation(params, mockMessageBus);
            // @ts-expect-error - accessing private method for testing
            const hintedParams = invocation.withUserHints(params);
            expect(hintedParams.query).toBe('original query');
        });
        it('should prepend hints to query for remote agents when hints exist and steering is enabled', async () => {
            mockConfig = makeFakeConfig({ modelSteering: true });
            const tool = new SubagentTool(testRemoteDefinition, mockConfig, mockMessageBus);
            const params = { query: 'original query' };
            // @ts-expect-error - accessing private method for testing
            const invocation = tool.createInvocation(params, mockMessageBus);
            mockConfig.userHintService.addUserHint('Hint 1');
            mockConfig.userHintService.addUserHint('Hint 2');
            // @ts-expect-error - accessing private method for testing
            const hintedParams = invocation.withUserHints(params);
            expect(hintedParams.query).toContain('Hint 1');
            expect(hintedParams.query).toContain('Hint 2');
            expect(hintedParams.query).toMatch(/original query$/);
        });
        it('should NOT include legacy hints added before the invocation was created', async () => {
            mockConfig = makeFakeConfig({ modelSteering: true });
            mockConfig.userHintService.addUserHint('Legacy Hint');
            const tool = new SubagentTool(testRemoteDefinition, mockConfig, mockMessageBus);
            const params = { query: 'original query' };
            // Creation of invocation captures the current hint state
            // @ts-expect-error - accessing private method for testing
            const invocation = tool.createInvocation(params, mockMessageBus);
            // Verify no hints are present yet
            // @ts-expect-error - accessing private method for testing
            let hintedParams = invocation.withUserHints(params);
            expect(hintedParams.query).toBe('original query');
            // Add a new hint after creation
            mockConfig.userHintService.addUserHint('New Hint');
            // @ts-expect-error - accessing private method for testing
            hintedParams = invocation.withUserHints(params);
            expect(hintedParams.query).toContain('New Hint');
            expect(hintedParams.query).not.toContain('Legacy Hint');
        });
        it('should NOT modify query if query is missing or not a string', async () => {
            mockConfig = makeFakeConfig({ modelSteering: true });
            mockConfig.userHintService.addUserHint('Hint');
            const tool = new SubagentTool(testRemoteDefinition, mockConfig, mockMessageBus);
            const params = { other: 'param' };
            // @ts-expect-error - accessing private method for testing
            const invocation = tool.createInvocation(params, mockMessageBus);
            // @ts-expect-error - accessing private method for testing
            const hintedParams = invocation.withUserHints(params);
            expect(hintedParams).toEqual(params);
        });
    });
});
describe('SubagentTool Read-Only logic', () => {
    let mockConfig;
    let mockMessageBus;
    beforeEach(() => {
        vi.clearAllMocks();
        mockConfig = makeFakeConfig();
        mockMessageBus = createMockMessageBus();
    });
    it('should be false for remote agents', () => {
        const tool = new SubagentTool(testRemoteDefinition, mockConfig, mockMessageBus);
        expect(tool.isReadOnly).toBe(false);
    });
    it('should be true for local agent with only read-only tools', () => {
        const readOnlyTool = {
            name: 'read',
            isReadOnly: true,
        };
        const registry = {
            getTool: (name) => (name === 'read' ? readOnlyTool : undefined),
        };
        vi.spyOn(mockConfig, 'getToolRegistry').mockReturnValue(registry);
        const defWithTools = {
            ...testDefinition,
            toolConfig: { tools: ['read'] },
        };
        const tool = new SubagentTool(defWithTools, mockConfig, mockMessageBus);
        expect(tool.isReadOnly).toBe(true);
    });
    it('should be false for local agent with at least one non-read-only tool', () => {
        const readOnlyTool = {
            name: 'read',
            isReadOnly: true,
        };
        const mutatorTool = {
            name: 'write',
            isReadOnly: false,
        };
        const registry = {
            getTool: (name) => {
                if (name === 'read')
                    return readOnlyTool;
                if (name === 'write')
                    return mutatorTool;
                return undefined;
            },
        };
        vi.spyOn(mockConfig, 'getToolRegistry').mockReturnValue(registry);
        const defWithTools = {
            ...testDefinition,
            toolConfig: { tools: ['read', 'write'] },
        };
        const tool = new SubagentTool(defWithTools, mockConfig, mockMessageBus);
        expect(tool.isReadOnly).toBe(false);
    });
    it('should be true for local agent with no tools', () => {
        const registry = { getTool: () => undefined };
        vi.spyOn(mockConfig, 'getToolRegistry').mockReturnValue(registry);
        const defNoTools = {
            ...testDefinition,
            toolConfig: { tools: [] },
        };
        const tool = new SubagentTool(defNoTools, mockConfig, mockMessageBus);
        expect(tool.isReadOnly).toBe(true);
    });
});
//# sourceMappingURL=subagent-tool.test.js.map