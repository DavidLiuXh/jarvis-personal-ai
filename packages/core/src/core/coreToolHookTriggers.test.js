/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeToolWithHooks } from './coreToolHookTriggers.js';
import { ToolErrorType } from '../tools/tool-error.js';
import { BaseToolInvocation, } from '../tools/tools.js';
import { BeforeToolHookOutput, } from '../hooks/types.js';
class MockInvocation extends BaseToolInvocation {
    constructor(params, messageBus) {
        super(params, messageBus);
    }
    getDescription() {
        return 'mock';
    }
    async execute() {
        return {
            llmContent: this.params.key ? `key: ${this.params.key}` : 'success',
            returnDisplay: this.params.key
                ? `key: ${this.params.key}`
                : 'success display',
        };
    }
}
describe('executeToolWithHooks', () => {
    let messageBus;
    let mockTool;
    let mockHookSystem;
    let mockConfig;
    beforeEach(() => {
        messageBus = {
            request: vi.fn(),
            publish: vi.fn(),
            subscribe: vi.fn(),
            unsubscribe: vi.fn(),
        };
        mockHookSystem = {
            fireBeforeToolEvent: vi.fn(),
            fireAfterToolEvent: vi.fn(),
        };
        mockConfig = {
            getHookSystem: vi.fn().mockReturnValue(mockHookSystem),
            getMcpClientManager: vi.fn().mockReturnValue(undefined),
            getMcpServers: vi.fn().mockReturnValue({}),
        };
        mockTool = {
            build: vi
                .fn()
                .mockImplementation((params) => new MockInvocation(params, messageBus)),
        };
    });
    it('should prioritize continue: false over decision: block in BeforeTool', async () => {
        const invocation = new MockInvocation({}, messageBus);
        const abortSignal = new AbortController().signal;
        vi.mocked(mockHookSystem.fireBeforeToolEvent).mockResolvedValue({
            shouldStopExecution: () => true,
            getEffectiveReason: () => 'Stop immediately',
            getBlockingError: () => ({
                blocked: false,
                reason: 'Should be ignored because continue is false',
            }),
        });
        const result = await executeToolWithHooks(invocation, 'test_tool', abortSignal, mockTool, undefined, undefined, undefined, mockConfig);
        expect(result.error?.type).toBe(ToolErrorType.STOP_EXECUTION);
        expect(result.error?.message).toBe('Stop immediately');
    });
    it('should block execution in BeforeTool if decision is block', async () => {
        const invocation = new MockInvocation({}, messageBus);
        const abortSignal = new AbortController().signal;
        vi.mocked(mockHookSystem.fireBeforeToolEvent).mockResolvedValue({
            shouldStopExecution: () => false,
            getEffectiveReason: () => '',
            getBlockingError: () => ({ blocked: true, reason: 'Execution blocked' }),
        });
        const result = await executeToolWithHooks(invocation, 'test_tool', abortSignal, mockTool, undefined, undefined, undefined, mockConfig);
        expect(result.error?.type).toBe(ToolErrorType.EXECUTION_FAILED);
        expect(result.error?.message).toBe('Execution blocked');
    });
    it('should handle continue: false in AfterTool', async () => {
        const invocation = new MockInvocation({}, messageBus);
        const abortSignal = new AbortController().signal;
        const spy = vi.spyOn(invocation, 'execute');
        vi.mocked(mockHookSystem.fireBeforeToolEvent).mockResolvedValue({
            shouldStopExecution: () => false,
            getEffectiveReason: () => '',
            getBlockingError: () => ({ blocked: false, reason: '' }),
        });
        vi.mocked(mockHookSystem.fireAfterToolEvent).mockResolvedValue({
            shouldStopExecution: () => true,
            getEffectiveReason: () => 'Stop after execution',
            getBlockingError: () => ({ blocked: false, reason: '' }),
        });
        const result = await executeToolWithHooks(invocation, 'test_tool', abortSignal, mockTool, undefined, undefined, undefined, mockConfig);
        expect(result.error?.type).toBe(ToolErrorType.STOP_EXECUTION);
        expect(result.error?.message).toBe('Stop after execution');
        expect(spy).toHaveBeenCalled();
    });
    it('should block result in AfterTool if decision is deny', async () => {
        const invocation = new MockInvocation({}, messageBus);
        const abortSignal = new AbortController().signal;
        vi.mocked(mockHookSystem.fireBeforeToolEvent).mockResolvedValue({
            shouldStopExecution: () => false,
            getEffectiveReason: () => '',
            getBlockingError: () => ({ blocked: false, reason: '' }),
        });
        vi.mocked(mockHookSystem.fireAfterToolEvent).mockResolvedValue({
            shouldStopExecution: () => false,
            getEffectiveReason: () => '',
            getBlockingError: () => ({ blocked: true, reason: 'Result denied' }),
        });
        const result = await executeToolWithHooks(invocation, 'test_tool', abortSignal, mockTool, undefined, undefined, undefined, mockConfig);
        expect(result.error?.type).toBe(ToolErrorType.EXECUTION_FAILED);
        expect(result.error?.message).toBe('Result denied');
    });
    it('should apply modified tool input from BeforeTool hook', async () => {
        const params = { key: 'original' };
        const invocation = new MockInvocation(params, messageBus);
        const toolName = 'test-tool';
        const abortSignal = new AbortController().signal;
        const mockBeforeOutput = new BeforeToolHookOutput({
            continue: true,
            hookSpecificOutput: {
                hookEventName: 'BeforeTool',
                tool_input: { key: 'modified' },
            },
        });
        vi.mocked(mockHookSystem.fireBeforeToolEvent).mockResolvedValue(mockBeforeOutput);
        vi.mocked(mockHookSystem.fireAfterToolEvent).mockResolvedValue(undefined);
        const result = await executeToolWithHooks(invocation, toolName, abortSignal, mockTool, undefined, undefined, undefined, mockConfig);
        // Verify result reflects modified input
        expect(result.llmContent).toBe('key: modified\n\n[System] Tool input parameters (key) were modified by a hook before execution.');
        // Verify params object was modified in place
        expect(invocation.params.key).toBe('modified');
        expect(mockHookSystem.fireBeforeToolEvent).toHaveBeenCalled();
        expect(mockTool.build).toHaveBeenCalledWith({ key: 'modified' });
    });
    it('should not modify input if hook does not provide tool_input', async () => {
        const params = { key: 'original' };
        const invocation = new MockInvocation(params, messageBus);
        const toolName = 'test-tool';
        const abortSignal = new AbortController().signal;
        const mockBeforeOutput = new BeforeToolHookOutput({
            continue: true,
            hookSpecificOutput: {
                hookEventName: 'BeforeTool',
                // No tool input
            },
        });
        vi.mocked(mockHookSystem.fireBeforeToolEvent).mockResolvedValue(mockBeforeOutput);
        vi.mocked(mockHookSystem.fireAfterToolEvent).mockResolvedValue(undefined);
        const result = await executeToolWithHooks(invocation, toolName, abortSignal, mockTool, undefined, undefined, undefined, mockConfig);
        expect(result.llmContent).toBe('key: original');
        expect(invocation.params.key).toBe('original');
        expect(mockTool.build).not.toHaveBeenCalled();
    });
});
//# sourceMappingURL=coreToolHookTriggers.test.js.map