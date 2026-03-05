/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi, beforeEach, afterEach, } from 'vitest';
import { randomUUID } from 'node:crypto';
vi.mock('node:crypto', () => ({
    randomUUID: vi.fn(),
}));
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
import { logToolCall } from '../telemetry/loggers.js';
vi.mock('../telemetry/loggers.js', () => ({
    logToolCall: vi.fn(),
}));
vi.mock('../telemetry/types.js', () => ({
    ToolCallEvent: vi.fn().mockImplementation((call) => ({ ...call })),
}));
import { SchedulerStateManager, } from './state-manager.js';
import { resolveConfirmation } from './confirmation.js';
import { checkPolicy, updatePolicy } from './policy.js';
import { ToolExecutor } from './tool-executor.js';
import { ToolModificationHandler } from './tool-modifier.js';
vi.mock('./state-manager.js');
vi.mock('./confirmation.js');
vi.mock('./policy.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        checkPolicy: vi.fn(),
        updatePolicy: vi.fn(),
    };
});
vi.mock('./tool-executor.js');
vi.mock('./tool-modifier.js');
import { Scheduler } from './scheduler.js';
import { PolicyDecision, ApprovalMode } from '../policy/types.js';
import { ToolConfirmationOutcome, } from '../tools/tools.js';
import { CoreToolCallStatus, ROOT_SCHEDULER_ID, } from './types.js';
import { ToolErrorType } from '../tools/tool-error.js';
import { GeminiCliOperation } from '../telemetry/constants.js';
import * as ToolUtils from '../utils/tool-utils.js';
import { getToolCallContext, } from '../utils/toolCallContext.js';
import { coreEvents, CoreEvent, } from '../utils/events.js';
describe('Scheduler (Orchestrator)', () => {
    let scheduler;
    let signal;
    let abortController;
    // Mocked Services (Injected via Config/Options)
    let mockConfig;
    let mockMessageBus;
    let mockPolicyEngine;
    let mockToolRegistry;
    let getPreferredEditor;
    // Mocked Sub-components (Instantiated by Scheduler)
    let mockStateManager;
    let mockExecutor;
    let mockModifier;
    // Test Data
    const req1 = {
        callId: 'call-1',
        name: 'test-tool',
        args: { foo: 'bar' },
        isClientInitiated: false,
        prompt_id: 'prompt-1',
        schedulerId: ROOT_SCHEDULER_ID,
        parentCallId: undefined,
    };
    const req2 = {
        callId: 'call-2',
        name: 'test-tool',
        args: { foo: 'baz' },
        isClientInitiated: false,
        prompt_id: 'prompt-1',
        schedulerId: ROOT_SCHEDULER_ID,
        parentCallId: undefined,
    };
    const mockTool = {
        name: 'test-tool',
        build: vi.fn(),
    };
    const mockInvocation = {
        shouldConfirmExecute: vi.fn(),
    };
    beforeEach(() => {
        vi.mocked(randomUUID).mockReturnValue('123e4567-e89b-12d3-a456-426614174000');
        abortController = new AbortController();
        signal = abortController.signal;
        // --- Setup Injected Mocks ---
        mockPolicyEngine = {
            check: vi.fn().mockResolvedValue({ decision: PolicyDecision.ALLOW }),
        };
        mockToolRegistry = {
            getTool: vi.fn().mockReturnValue(mockTool),
            getAllToolNames: vi.fn().mockReturnValue(['test-tool']),
        };
        mockConfig = {
            getPolicyEngine: vi.fn().mockReturnValue(mockPolicyEngine),
            getToolRegistry: vi.fn().mockReturnValue(mockToolRegistry),
            isInteractive: vi.fn().mockReturnValue(true),
            getEnableHooks: vi.fn().mockReturnValue(true),
            setApprovalMode: vi.fn(),
            getApprovalMode: vi.fn().mockReturnValue(ApprovalMode.DEFAULT),
        };
        mockMessageBus = {
            publish: vi.fn(),
            subscribe: vi.fn(),
        };
        getPreferredEditor = vi.fn().mockReturnValue('vim');
        // --- Setup Sub-component Mocks ---
        const mockActiveCallsMap = new Map();
        const mockQueue = [];
        mockStateManager = {
            enqueue: vi.fn((calls) => {
                // Clone to preserve initial state for Phase 1 tests
                mockQueue.push(...calls.map((c) => ({ ...c })));
            }),
            dequeue: vi.fn(() => {
                const next = mockQueue.shift();
                if (next)
                    mockActiveCallsMap.set(next.request.callId, next);
                return next;
            }),
            peekQueue: vi.fn(() => mockQueue[0]),
            getToolCall: vi.fn((id) => mockActiveCallsMap.get(id)),
            updateStatus: vi.fn((id, status) => {
                const call = mockActiveCallsMap.get(id);
                if (call)
                    call.status = status;
            }),
            finalizeCall: vi.fn((id) => {
                const call = mockActiveCallsMap.get(id);
                if (call) {
                    mockActiveCallsMap.delete(id);
                    capturedTerminalHandler?.(call);
                }
            }),
            updateArgs: vi.fn(),
            setOutcome: vi.fn(),
            cancelAllQueued: vi.fn(() => {
                mockQueue.length = 0;
            }),
            clearBatch: vi.fn(),
            replaceActiveCallWithTailCall: vi.fn((id, nextCall) => {
                if (mockActiveCallsMap.has(id)) {
                    mockActiveCallsMap.delete(id);
                    mockQueue.unshift(nextCall);
                }
            }),
        };
        // Define getters for accessors idiomatically
        Object.defineProperty(mockStateManager, 'isActive', {
            get: vi.fn(() => mockActiveCallsMap.size > 0),
            configurable: true,
        });
        Object.defineProperty(mockStateManager, 'allActiveCalls', {
            get: vi.fn(() => Array.from(mockActiveCallsMap.values())),
            configurable: true,
        });
        Object.defineProperty(mockStateManager, 'queueLength', {
            get: vi.fn(() => mockQueue.length),
            configurable: true,
        });
        Object.defineProperty(mockStateManager, 'firstActiveCall', {
            get: vi.fn(() => mockActiveCallsMap.values().next().value),
            configurable: true,
        });
        Object.defineProperty(mockStateManager, 'completedBatch', {
            get: vi.fn().mockReturnValue([]),
            configurable: true,
        });
        vi.spyOn(mockStateManager, 'cancelAllQueued').mockImplementation(() => { });
        vi.spyOn(mockStateManager, 'clearBatch').mockImplementation(() => { });
        vi.mocked(resolveConfirmation).mockReset();
        vi.mocked(checkPolicy).mockReset();
        vi.mocked(checkPolicy).mockResolvedValue({
            decision: PolicyDecision.ALLOW,
            rule: undefined,
        });
        vi.mocked(updatePolicy).mockReset();
        mockExecutor = {
            execute: vi.fn(),
        };
        mockModifier = {
            handleModifyWithEditor: vi.fn(),
            applyInlineModify: vi.fn(),
        };
        let capturedTerminalHandler;
        vi.mocked(SchedulerStateManager).mockImplementation((_messageBus, _schedulerId, onTerminalCall) => {
            capturedTerminalHandler = onTerminalCall;
            return mockStateManager;
        });
        mockStateManager.finalizeCall.mockImplementation((callId) => {
            const call = mockActiveCallsMap.get(callId);
            if (call) {
                mockActiveCallsMap.delete(callId);
                capturedTerminalHandler?.(call);
            }
        });
        mockStateManager.cancelAllQueued.mockImplementation((_reason) => {
            // In tests, we usually mock the queue or completed batch.
            // For the sake of telemetry tests, we manually trigger if needed,
            // but most tests here check if finalizing is called.
        });
        vi.mocked(ToolExecutor).mockReturnValue(mockExecutor);
        mockExecutor.execute.mockResolvedValue({
            status: 'success',
            response: {
                callId: 'default',
                responseParts: [],
            },
        });
        vi.mocked(ToolModificationHandler).mockReturnValue(mockModifier);
        // Initialize Scheduler
        scheduler = new Scheduler({
            config: mockConfig,
            messageBus: mockMessageBus,
            getPreferredEditor,
            schedulerId: 'root',
        });
        // Reset Tool build behavior
        vi.mocked(mockTool.build).mockReturnValue(mockInvocation);
    });
    afterEach(() => {
        vi.clearAllMocks();
    });
    describe('Phase 1: Ingestion & Resolution', () => {
        it('should create an ErroredToolCall if tool is not found', async () => {
            vi.mocked(mockToolRegistry.getTool).mockReturnValue(undefined);
            vi.spyOn(ToolUtils, 'getToolSuggestion').mockReturnValue(' (Did you mean "test-tool"?)');
            await scheduler.schedule(req1, signal);
            // Verify it was enqueued with an error status
            expect(mockStateManager.enqueue).toHaveBeenCalledWith(expect.arrayContaining([
                expect.objectContaining({
                    status: CoreToolCallStatus.Error,
                    response: expect.objectContaining({
                        errorType: ToolErrorType.TOOL_NOT_REGISTERED,
                    }),
                }),
            ]));
        });
        it('should create an ErroredToolCall if tool.build throws (invalid args)', async () => {
            vi.mocked(mockTool.build).mockImplementation(() => {
                throw new Error('Invalid schema');
            });
            await scheduler.schedule(req1, signal);
            expect(mockStateManager.enqueue).toHaveBeenCalledWith(expect.arrayContaining([
                expect.objectContaining({
                    status: CoreToolCallStatus.Error,
                    response: expect.objectContaining({
                        errorType: ToolErrorType.INVALID_TOOL_PARAMS,
                    }),
                }),
            ]));
        });
        it('should correctly build ValidatingToolCalls for happy path', async () => {
            await scheduler.schedule(req1, signal);
            expect(mockStateManager.enqueue).toHaveBeenCalledWith(expect.arrayContaining([
                expect.objectContaining({
                    status: CoreToolCallStatus.Validating,
                    request: req1,
                    tool: mockTool,
                    invocation: mockInvocation,
                    schedulerId: ROOT_SCHEDULER_ID,
                    startTime: expect.any(Number),
                }),
            ]));
            expect(runInDevTraceSpan).toHaveBeenCalledWith(expect.objectContaining({
                operation: GeminiCliOperation.ScheduleToolCalls,
            }), expect.any(Function));
            const spanArgs = vi.mocked(runInDevTraceSpan).mock.calls[0];
            const fn = spanArgs[1];
            const metadata = { attributes: {} };
            await fn({ metadata, endSpan: vi.fn() });
            expect(metadata).toMatchObject({
                input: [req1],
            });
        });
        it('should set approvalMode to PLAN when config returns PLAN', async () => {
            mockConfig.getApprovalMode.mockReturnValue(ApprovalMode.PLAN);
            await scheduler.schedule(req1, signal);
            expect(mockStateManager.enqueue).toHaveBeenCalledWith(expect.arrayContaining([
                expect.objectContaining({
                    status: CoreToolCallStatus.Validating,
                    approvalMode: ApprovalMode.PLAN,
                }),
            ]));
        });
    });
    describe('Phase 2: Queue Management', () => {
        it('should drain the queue if multiple calls are scheduled', async () => {
            // Execute is the end of the loop, stub it
            mockExecutor.execute.mockResolvedValue({
                status: CoreToolCallStatus.Success,
            });
            await scheduler.schedule(req1, signal);
            // Verify loop ran once for this schedule call (which had 1 request)
            // schedule(req1) enqueues 1 request.
            expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
        });
        it('should execute tool calls sequentially (first completes before second starts)', async () => {
            const executionLog = [];
            // Mock executor to push to log with a deterministic microtask delay
            mockExecutor.execute.mockImplementation(async ({ call }) => {
                const id = call.request.callId;
                executionLog.push(`start-${id}`);
                // Yield to the event loop deterministically using queueMicrotask
                await new Promise((resolve) => queueMicrotask(resolve));
                executionLog.push(`end-${id}`);
                return {
                    status: CoreToolCallStatus.Success,
                };
            });
            // Action: Schedule batch of 2 tools
            await scheduler.schedule([req1, req2], signal);
            // Assert: The second tool only started AFTER the first one ended
            expect(executionLog).toEqual([
                'start-call-1',
                'end-call-1',
                'start-call-2',
                'end-call-2',
            ]);
        });
        it('should queue and process multiple schedule() calls made synchronously', async () => {
            // Executor succeeds instantly
            mockExecutor.execute.mockResolvedValue({
                status: CoreToolCallStatus.Success,
            });
            // ACT: Call schedule twice synchronously (without awaiting the first)
            const promise1 = scheduler.schedule(req1, signal);
            const promise2 = scheduler.schedule(req2, signal);
            await Promise.all([promise1, promise2]);
            // ASSERT: Both requests were eventually pulled from the queue and executed
            expect(mockExecutor.execute).toHaveBeenCalledTimes(2);
            expect(mockStateManager.finalizeCall).toHaveBeenCalledWith('call-1');
            expect(mockStateManager.finalizeCall).toHaveBeenCalledWith('call-2');
        });
        it('should queue requests when scheduler is busy (overlapping batches)', async () => {
            // 2. Setup Executor with a controllable lock for the first batch
            const executionLog = [];
            let finishFirstBatch;
            const firstBatchPromise = new Promise((resolve) => {
                finishFirstBatch = resolve;
            });
            mockExecutor.execute.mockImplementationOnce(async () => {
                executionLog.push('start-batch-1');
                await firstBatchPromise; // Simulating long-running tool execution
                executionLog.push('end-batch-1');
                return {
                    status: CoreToolCallStatus.Success,
                };
            });
            mockExecutor.execute.mockImplementationOnce(async () => {
                executionLog.push('start-batch-2');
                executionLog.push('end-batch-2');
                return {
                    status: CoreToolCallStatus.Success,
                };
            });
            // 3. ACTIONS
            // Start Batch 1 (it will block indefinitely inside execution)
            const promise1 = scheduler.schedule(req1, signal);
            // Schedule Batch 2 WHILE Batch 1 is executing
            const promise2 = scheduler.schedule(req2, signal);
            // Yield event loop to let promise2 hit the queue
            await new Promise((r) => setTimeout(r, 0));
            // At this point, Batch 2 should NOT have started
            expect(executionLog).not.toContain('start-batch-2');
            // Now resolve Batch 1, which should trigger the request queue drain
            finishFirstBatch({});
            await Promise.all([promise1, promise2]);
            // 4. ASSERTIONS
            // Verify complete sequential ordering of the two overlapping batches
            expect(executionLog).toEqual([
                'start-batch-1',
                'end-batch-1',
                'start-batch-2',
                'end-batch-2',
            ]);
        });
        it('should cancel all queues if AbortSignal is triggered during loop', async () => {
            Object.defineProperty(mockStateManager, 'queueLength', {
                get: vi.fn().mockReturnValue(1),
                configurable: true,
            });
            abortController.abort(); // Signal aborted
            await scheduler.schedule(req1, signal);
            expect(mockStateManager.cancelAllQueued).toHaveBeenCalledWith('Operation cancelled');
            expect(mockStateManager.dequeue).not.toHaveBeenCalled(); // Loop broke
        });
        it('cancelAll() should cancel active call and clear queue', () => {
            const activeCall = {
                status: CoreToolCallStatus.Validating,
                request: req1,
                tool: mockTool,
                invocation: mockInvocation,
            };
            mockStateManager.enqueue([activeCall]);
            mockStateManager.dequeue();
            scheduler.cancelAll();
            expect(mockStateManager.updateStatus).toHaveBeenCalledWith('call-1', CoreToolCallStatus.Cancelled, 'Operation cancelled by user');
            // finalizeCall is handled by the processing loop, not synchronously by cancelAll
            // expect(mockStateManager.finalizeCall).toHaveBeenCalledWith('call-1');
            expect(mockStateManager.cancelAllQueued).toHaveBeenCalledWith('Operation cancelled by user');
        });
        it('cancelAll() should clear the requestQueue and reject pending promises', async () => {
            // 1. Setup a busy scheduler with one batch processing
            Object.defineProperty(mockStateManager, 'isActive', {
                get: vi.fn().mockReturnValue(true),
                configurable: true,
            });
            const promise1 = scheduler.schedule(req1, signal);
            // Catch promise1 to avoid unhandled rejection when we cancelAll
            promise1.catch(() => { });
            // 2. Queue another batch while the first is busy
            const promise2 = scheduler.schedule(req2, signal);
            // 3. ACT: Cancel everything
            scheduler.cancelAll();
            // 4. ASSERT: The second batch's promise should be rejected
            await expect(promise2).rejects.toThrow('Operation cancelled by user');
        });
    });
    describe('Phase 3: Policy & Confirmation Loop', () => {
        beforeEach(() => { });
        it('should update state to error with POLICY_VIOLATION if Policy returns DENY', async () => {
            vi.mocked(checkPolicy).mockResolvedValue({
                decision: PolicyDecision.DENY,
                rule: undefined,
            });
            await scheduler.schedule(req1, signal);
            expect(mockStateManager.updateStatus).toHaveBeenCalledWith('call-1', CoreToolCallStatus.Error, expect.objectContaining({
                errorType: ToolErrorType.POLICY_VIOLATION,
            }));
            // Deny shouldn't throw, execution is just skipped, state is updated
            expect(mockExecutor.execute).not.toHaveBeenCalled();
        });
        it('should include denyMessage in error response if present', async () => {
            vi.mocked(checkPolicy).mockResolvedValue({
                decision: PolicyDecision.DENY,
                rule: {
                    decision: PolicyDecision.DENY,
                    denyMessage: 'Custom denial reason',
                },
            });
            await scheduler.schedule(req1, signal);
            expect(mockStateManager.updateStatus).toHaveBeenCalledWith('call-1', CoreToolCallStatus.Error, expect.objectContaining({
                errorType: ToolErrorType.POLICY_VIOLATION,
                responseParts: expect.arrayContaining([
                    expect.objectContaining({
                        functionResponse: expect.objectContaining({
                            response: {
                                error: 'Tool execution denied by policy. Custom denial reason',
                            },
                        }),
                    }),
                ]),
            }));
        });
        it('should handle errors from checkPolicy (e.g. non-interactive ASK_USER)', async () => {
            const error = new Error('Not interactive');
            vi.mocked(checkPolicy).mockRejectedValue(error);
            await scheduler.schedule(req1, signal);
            expect(mockStateManager.updateStatus).toHaveBeenCalledWith('call-1', CoreToolCallStatus.Error, expect.objectContaining({
                errorType: ToolErrorType.UNHANDLED_EXCEPTION,
                responseParts: expect.arrayContaining([
                    expect.objectContaining({
                        functionResponse: expect.objectContaining({
                            response: { error: 'Not interactive' },
                        }),
                    }),
                ]),
            }));
        });
        it('should return POLICY_VIOLATION error type when denied in Plan Mode', async () => {
            vi.mocked(checkPolicy).mockResolvedValue({
                decision: PolicyDecision.DENY,
                rule: { decision: PolicyDecision.DENY },
            });
            mockConfig.getApprovalMode.mockReturnValue(ApprovalMode.PLAN);
            await scheduler.schedule(req1, signal);
            expect(mockStateManager.updateStatus).toHaveBeenCalledWith('call-1', CoreToolCallStatus.Error, expect.objectContaining({
                errorType: ToolErrorType.POLICY_VIOLATION,
                responseParts: expect.arrayContaining([
                    expect.objectContaining({
                        functionResponse: expect.objectContaining({
                            response: {
                                error: 'Tool execution denied by policy.',
                            },
                        }),
                    }),
                ]),
            }));
        });
        it('should return POLICY_VIOLATION and custom deny message when denied in Plan Mode with rule message', async () => {
            const customMessage = 'Custom Plan Mode Deny';
            vi.mocked(checkPolicy).mockResolvedValue({
                decision: PolicyDecision.DENY,
                rule: { decision: PolicyDecision.DENY, denyMessage: customMessage },
            });
            mockConfig.getApprovalMode.mockReturnValue(ApprovalMode.PLAN);
            await scheduler.schedule(req1, signal);
            expect(mockStateManager.updateStatus).toHaveBeenCalledWith('call-1', CoreToolCallStatus.Error, expect.objectContaining({
                errorType: ToolErrorType.POLICY_VIOLATION,
                responseParts: expect.arrayContaining([
                    expect.objectContaining({
                        functionResponse: expect.objectContaining({
                            response: {
                                error: `Tool execution denied by policy. ${customMessage}`,
                            },
                        }),
                    }),
                ]),
            }));
        });
        it('should bypass confirmation and ProceedOnce if Policy returns ALLOW (YOLO/AllowedTools)', async () => {
            vi.mocked(checkPolicy).mockResolvedValue({
                decision: PolicyDecision.ALLOW,
                rule: undefined,
            });
            // Provide a mock execute to finish the loop
            mockExecutor.execute.mockResolvedValue({
                status: CoreToolCallStatus.Success,
            });
            await scheduler.schedule(req1, signal);
            // Never called coordinator
            expect(resolveConfirmation).not.toHaveBeenCalled();
            // State recorded as ProceedOnce
            expect(mockStateManager.setOutcome).toHaveBeenCalledWith('call-1', ToolConfirmationOutcome.ProceedOnce);
            // Triggered execution
            expect(mockStateManager.updateStatus).toHaveBeenCalledWith('call-1', CoreToolCallStatus.Executing);
            expect(mockExecutor.execute).toHaveBeenCalled();
        });
        it('should auto-approve remaining identical tools in batch after ProceedAlways', async () => {
            // First call requires confirmation, second is auto-approved (simulating policy update)
            vi.mocked(checkPolicy)
                .mockResolvedValueOnce({
                decision: PolicyDecision.ASK_USER,
                rule: undefined,
            })
                .mockResolvedValueOnce({
                decision: PolicyDecision.ALLOW,
                rule: undefined,
            });
            vi.mocked(resolveConfirmation).mockResolvedValue({
                outcome: ToolConfirmationOutcome.ProceedAlways,
                lastDetails: undefined,
            });
            mockExecutor.execute.mockResolvedValue({
                status: CoreToolCallStatus.Success,
            });
            await scheduler.schedule([req1, req2], signal);
            // resolveConfirmation only called ONCE
            expect(resolveConfirmation).toHaveBeenCalledTimes(1);
            // updatePolicy called for the first tool
            expect(updatePolicy).toHaveBeenCalled();
            // execute called TWICE
            expect(mockExecutor.execute).toHaveBeenCalledTimes(2);
        });
        it('should call resolveConfirmation and updatePolicy when ASK_USER', async () => {
            vi.mocked(checkPolicy).mockResolvedValue({
                decision: PolicyDecision.ASK_USER,
                rule: undefined,
            });
            const resolution = {
                outcome: ToolConfirmationOutcome.ProceedAlways,
                lastDetails: {
                    type: 'info',
                    title: 'Title',
                    prompt: 'Confirm?',
                },
            };
            vi.mocked(resolveConfirmation).mockResolvedValue(resolution);
            mockExecutor.execute.mockResolvedValue({
                status: CoreToolCallStatus.Success,
            });
            await scheduler.schedule(req1, signal);
            expect(resolveConfirmation).toHaveBeenCalledWith(expect.anything(), // toolCall
            signal, expect.objectContaining({
                config: mockConfig,
                messageBus: mockMessageBus,
                state: mockStateManager,
                schedulerId: ROOT_SCHEDULER_ID,
            }));
            expect(updatePolicy).toHaveBeenCalledWith(mockTool, resolution.outcome, resolution.lastDetails, expect.objectContaining({
                config: mockConfig,
                messageBus: mockMessageBus,
            }));
            expect(mockExecutor.execute).toHaveBeenCalled();
        });
        it('should cancel and NOT execute if resolveConfirmation returns Cancel', async () => {
            vi.mocked(checkPolicy).mockResolvedValue({
                decision: PolicyDecision.ASK_USER,
                rule: undefined,
            });
            const resolution = {
                outcome: ToolConfirmationOutcome.Cancel,
                lastDetails: undefined,
            };
            vi.mocked(resolveConfirmation).mockResolvedValue(resolution);
            await scheduler.schedule(req1, signal);
            expect(mockStateManager.updateStatus).toHaveBeenCalledWith('call-1', CoreToolCallStatus.Cancelled, 'User denied execution.');
            expect(mockStateManager.setOutcome).toHaveBeenCalledWith('call-1', ToolConfirmationOutcome.Cancel);
            expect(mockStateManager.cancelAllQueued).toHaveBeenCalledWith('User cancelled operation');
            expect(mockExecutor.execute).not.toHaveBeenCalled();
        });
        it('should mark as cancelled (not errored) when abort happens during confirmation error', async () => {
            vi.mocked(checkPolicy).mockResolvedValue({
                decision: PolicyDecision.ASK_USER,
                rule: undefined,
            });
            // Simulate shouldConfirmExecute logic throwing while aborted
            vi.mocked(resolveConfirmation).mockImplementation(async () => {
                // Trigger abort
                abortController.abort();
                throw new Error('Some internal network abort error');
            });
            await scheduler.schedule(req1, signal);
            // Verify execution did NOT happen
            expect(mockExecutor.execute).not.toHaveBeenCalled();
            // Because the signal is aborted, the catch block should convert the error to a cancellation
            expect(mockStateManager.updateStatus).toHaveBeenCalledWith('call-1', CoreToolCallStatus.Cancelled, 'Operation cancelled');
        });
        it('should preserve confirmation details (e.g. diff) in cancelled state', async () => {
            vi.mocked(checkPolicy).mockResolvedValue({
                decision: PolicyDecision.ASK_USER,
                rule: undefined,
            });
            const confirmDetails = {
                type: 'edit',
                title: 'Edit',
                fileName: 'file.txt',
                fileDiff: 'diff content',
                filePath: '/path/to/file.txt',
                originalContent: 'old',
                newContent: 'new',
            };
            const resolution = {
                outcome: ToolConfirmationOutcome.Cancel,
                lastDetails: confirmDetails,
            };
            vi.mocked(resolveConfirmation).mockResolvedValue(resolution);
            await scheduler.schedule(req1, signal);
            expect(mockStateManager.updateStatus).toHaveBeenCalledWith('call-1', CoreToolCallStatus.Cancelled, 'User denied execution.');
            // We assume the state manager stores these details.
            // Since we mock state manager, we just verify the flow passed the details.
            // In a real integration, StateManager.updateStatus would merge these.
        });
    });
    describe('Phase 4: Execution Outcomes', () => {
        beforeEach(() => {
            mockPolicyEngine.check.mockResolvedValue({
                decision: PolicyDecision.ALLOW,
            }); // Bypass confirmation
        });
        it('should update state to success on successful execution', async () => {
            const mockResponse = {
                callId: 'call-1',
                responseParts: [],
            };
            mockExecutor.execute.mockResolvedValue({
                status: CoreToolCallStatus.Success,
                response: mockResponse,
            });
            await scheduler.schedule(req1, signal);
            expect(mockStateManager.updateStatus).toHaveBeenCalledWith('call-1', CoreToolCallStatus.Success, mockResponse);
        });
        it('should update state to cancelled when executor returns cancelled status', async () => {
            mockExecutor.execute.mockResolvedValue({
                status: CoreToolCallStatus.Cancelled,
                response: { callId: 'call-1', responseParts: [] },
            });
            await scheduler.schedule(req1, signal);
            expect(mockStateManager.updateStatus).toHaveBeenCalledWith('call-1', CoreToolCallStatus.Cancelled, { callId: 'call-1', responseParts: [] });
        });
        it('should update state to error on execution failure', async () => {
            const mockResponse = {
                callId: 'call-1',
                error: new Error('fail'),
            };
            mockExecutor.execute.mockResolvedValue({
                status: CoreToolCallStatus.Error,
                response: mockResponse,
            });
            await scheduler.schedule(req1, signal);
            expect(mockStateManager.updateStatus).toHaveBeenCalledWith('call-1', CoreToolCallStatus.Error, mockResponse);
        });
        it('should log telemetry for terminal states in the queue processor', async () => {
            const mockResponse = {
                callId: 'call-1',
                responseParts: [],
            };
            // Mock the execution so the state advances
            mockExecutor.execute.mockResolvedValue({
                status: CoreToolCallStatus.Success,
                response: mockResponse,
            });
            await scheduler.schedule(req1, signal);
            // Verify the finalizer and logger were called
            expect(mockStateManager.finalizeCall).toHaveBeenCalledWith('call-1');
            // We check that logToolCall was called (it's called via the state manager's terminal handler)
            expect(logToolCall).toHaveBeenCalled();
        });
        it('should not double-report completed tools when concurrent completions occur', async () => {
            // Simulate a race where execution finishes but cancelAll is called immediately after
            const response = {
                callId: 'call-1',
                responseParts: [],
                resultDisplay: undefined,
                error: undefined,
                errorType: undefined,
                contentLength: 0,
            };
            mockExecutor.execute.mockResolvedValue({
                status: CoreToolCallStatus.Success,
                response,
            });
            const promise = scheduler.schedule(req1, signal);
            scheduler.cancelAll();
            await promise;
            // finalizeCall should be called exactly once for this ID
            expect(mockStateManager.finalizeCall).toHaveBeenCalledTimes(1);
            expect(mockStateManager.finalizeCall).toHaveBeenCalledWith('call-1');
        });
        it('should break the loop if no progress is made (safeguard against stuck states)', async () => {
            // Setup: A tool that is 'validating' but stays 'validating' even after processing
            // This simulates a bug in state management or a weird edge case.
            const stuckCall = {
                status: CoreToolCallStatus.Validating,
                request: req1,
                tool: mockTool,
                invocation: mockInvocation,
            };
            // Mock dequeue to keep returning the same stuck call
            mockStateManager.dequeue.mockReturnValue(stuckCall);
            // Mock isActive to be true
            Object.defineProperty(mockStateManager, 'isActive', {
                get: vi.fn().mockReturnValue(true),
                configurable: true,
            });
            // Mock updateStatus to do NOTHING (simulating no progress)
            mockStateManager.updateStatus.mockImplementation(() => { });
            // This should return false (break loop) instead of hanging indefinitely
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const result = await scheduler._processNextItem(signal);
            expect(result).toBe(false);
        });
        describe('Tail Calls', () => {
            it('should replace the active call with a new tool call and re-run the loop when tail call is requested', async () => {
                // Setup: Tool A will return a success with a tail call request to Tool B
                const mockResponse = {
                    callId: 'call-1',
                    responseParts: [],
                };
                mockExecutor.execute
                    .mockResolvedValueOnce({
                    status: 'success',
                    response: mockResponse,
                    tailToolCallRequest: {
                        name: 'tool-b',
                        args: { key: 'value' },
                    },
                    request: req1,
                })
                    .mockResolvedValueOnce({
                    status: 'success',
                    response: mockResponse,
                    request: {
                        ...req1,
                        name: 'tool-b',
                        args: { key: 'value' },
                        originalRequestName: 'test-tool',
                    },
                });
                const mockToolB = {
                    name: 'tool-b',
                    build: vi.fn().mockReturnValue({}),
                };
                vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockToolB);
                await scheduler.schedule(req1, signal);
                // Assert: The state manager is instructed to replace the call
                expect(mockStateManager.replaceActiveCallWithTailCall).toHaveBeenCalledWith('call-1', expect.objectContaining({
                    request: expect.objectContaining({
                        callId: 'call-1',
                        name: 'tool-b',
                        args: { key: 'value' },
                        originalRequestName: 'test-tool', // Preserves original name
                    }),
                    tool: mockToolB,
                }));
                // Assert: The executor should be called twice (once for Tool A, once for Tool B)
                expect(mockExecutor.execute).toHaveBeenCalledTimes(2);
            });
            it('should inject an errored tool call if the tail tool is not found', async () => {
                const mockResponse = {
                    callId: 'call-1',
                    responseParts: [],
                };
                mockExecutor.execute.mockResolvedValue({
                    status: 'success',
                    response: mockResponse,
                    tailToolCallRequest: {
                        name: 'missing-tool',
                        args: {},
                    },
                    request: req1,
                });
                // Tool registry returns undefined for missing-tool, but valid tool for test-tool
                vi.mocked(mockToolRegistry.getTool).mockImplementation((name) => {
                    if (name === 'test-tool') {
                        return {
                            name: 'test-tool',
                            build: vi.fn().mockReturnValue({}),
                        };
                    }
                    return undefined;
                });
                await scheduler.schedule(req1, signal);
                // Assert: Replaces active call with an errored call
                expect(mockStateManager.replaceActiveCallWithTailCall).toHaveBeenCalledWith('call-1', expect.objectContaining({
                    status: 'error',
                    request: expect.objectContaining({
                        callId: 'call-1',
                        name: 'missing-tool', // Name of the failed tail call
                        originalRequestName: 'test-tool',
                    }),
                    response: expect.objectContaining({
                        errorType: ToolErrorType.TOOL_NOT_REGISTERED,
                    }),
                }));
            });
        });
    });
    describe('Tool Call Context Propagation', () => {
        it('should propagate context to the tool executor', async () => {
            const schedulerId = 'custom-scheduler';
            const parentCallId = 'parent-call';
            const customScheduler = new Scheduler({
                config: mockConfig,
                messageBus: mockMessageBus,
                getPreferredEditor,
                schedulerId,
                parentCallId,
            });
            mockToolRegistry.getTool.mockReturnValue(mockTool);
            mockPolicyEngine.check.mockResolvedValue({
                decision: PolicyDecision.ALLOW,
            });
            let capturedContext;
            mockExecutor.execute.mockImplementation(async () => {
                capturedContext = getToolCallContext();
                return {
                    status: CoreToolCallStatus.Success,
                    request: req1,
                    tool: mockTool,
                    invocation: mockInvocation,
                    response: {
                        callId: req1.callId,
                        responseParts: [],
                        resultDisplay: 'ok',
                        error: undefined,
                        errorType: undefined,
                    },
                };
            });
            await customScheduler.schedule(req1, signal);
            expect(capturedContext).toBeDefined();
            expect(capturedContext.callId).toBe(req1.callId);
            expect(capturedContext.schedulerId).toBe(schedulerId);
            expect(capturedContext.parentCallId).toBe(parentCallId);
        });
    });
    describe('Cleanup', () => {
        it('should unregister McpProgress listener on dispose()', () => {
            const onSpy = vi.spyOn(coreEvents, 'on');
            const offSpy = vi.spyOn(coreEvents, 'off');
            const s = new Scheduler({
                config: mockConfig,
                messageBus: mockMessageBus,
                getPreferredEditor,
                schedulerId: 'cleanup-test',
            });
            expect(onSpy).toHaveBeenCalledWith(CoreEvent.McpProgress, expect.any(Function));
            s.dispose();
            expect(offSpy).toHaveBeenCalledWith(CoreEvent.McpProgress, expect.any(Function));
        });
    });
});
describe('Scheduler MCP Progress', () => {
    let scheduler;
    let mockStateManager;
    let mockActiveCallsMap;
    let mockConfig;
    let mockMessageBus;
    let getPreferredEditor;
    const makePayload = (callId, progress, overrides = {}) => ({
        serverName: 'test-server',
        callId,
        progressToken: 'tok-1',
        progress,
        ...overrides,
    });
    const makeExecutingCall = (callId) => ({
        status: CoreToolCallStatus.Executing,
        request: {
            callId,
            name: 'mcp-tool',
            args: {},
            isClientInitiated: false,
            prompt_id: 'p-1',
            schedulerId: ROOT_SCHEDULER_ID,
            parentCallId: undefined,
        },
        tool: {
            name: 'mcp-tool',
            build: vi.fn(),
        },
        invocation: {},
    });
    beforeEach(() => {
        vi.mocked(randomUUID).mockReturnValue('123e4567-e89b-12d3-a456-426614174000');
        mockActiveCallsMap = new Map();
        mockStateManager = {
            enqueue: vi.fn(),
            dequeue: vi.fn(),
            peekQueue: vi.fn(),
            getToolCall: vi.fn((id) => mockActiveCallsMap.get(id)),
            updateStatus: vi.fn(),
            finalizeCall: vi.fn(),
            updateArgs: vi.fn(),
            setOutcome: vi.fn(),
            cancelAllQueued: vi.fn(),
            clearBatch: vi.fn(),
        };
        Object.defineProperty(mockStateManager, 'isActive', {
            get: vi.fn(() => mockActiveCallsMap.size > 0),
            configurable: true,
        });
        Object.defineProperty(mockStateManager, 'allActiveCalls', {
            get: vi.fn(() => Array.from(mockActiveCallsMap.values())),
            configurable: true,
        });
        Object.defineProperty(mockStateManager, 'queueLength', {
            get: vi.fn(() => 0),
            configurable: true,
        });
        Object.defineProperty(mockStateManager, 'firstActiveCall', {
            get: vi.fn(() => mockActiveCallsMap.values().next().value),
            configurable: true,
        });
        Object.defineProperty(mockStateManager, 'completedBatch', {
            get: vi.fn().mockReturnValue([]),
            configurable: true,
        });
        const mockPolicyEngine = {
            check: vi.fn().mockResolvedValue({ decision: PolicyDecision.ALLOW }),
        };
        const mockToolRegistry = {
            getTool: vi.fn(),
            getAllToolNames: vi.fn().mockReturnValue([]),
        };
        mockConfig = {
            getPolicyEngine: vi.fn().mockReturnValue(mockPolicyEngine),
            getToolRegistry: vi.fn().mockReturnValue(mockToolRegistry),
            isInteractive: vi.fn().mockReturnValue(true),
            getEnableHooks: vi.fn().mockReturnValue(true),
            setApprovalMode: vi.fn(),
            getApprovalMode: vi.fn().mockReturnValue(ApprovalMode.DEFAULT),
        };
        mockMessageBus = {
            publish: vi.fn(),
            subscribe: vi.fn(),
        };
        getPreferredEditor = vi.fn().mockReturnValue('vim');
        vi.mocked(SchedulerStateManager).mockImplementation((_messageBus, _schedulerId, _onTerminalCall) => mockStateManager);
        scheduler = new Scheduler({
            config: mockConfig,
            messageBus: mockMessageBus,
            getPreferredEditor,
            schedulerId: 'progress-test',
        });
    });
    afterEach(() => {
        scheduler.dispose();
        vi.clearAllMocks();
    });
    it('should update state on progress event', () => {
        const call = makeExecutingCall('call-A');
        mockActiveCallsMap.set('call-A', call);
        coreEvents.emit(CoreEvent.McpProgress, makePayload('call-A', 10));
        expect(mockStateManager.updateStatus).toHaveBeenCalledTimes(1);
        expect(mockStateManager.updateStatus).toHaveBeenCalledWith('call-A', CoreToolCallStatus.Executing, expect.objectContaining({ progress: 10 }));
    });
    it('should not respond to progress events after dispose()', () => {
        const call = makeExecutingCall('call-A');
        mockActiveCallsMap.set('call-A', call);
        scheduler.dispose();
        coreEvents.emit(CoreEvent.McpProgress, makePayload('call-A', 10));
        expect(mockStateManager.updateStatus).not.toHaveBeenCalled();
    });
    it('should handle concurrent calls independently', () => {
        const callA = makeExecutingCall('call-A');
        const callB = makeExecutingCall('call-B');
        mockActiveCallsMap.set('call-A', callA);
        mockActiveCallsMap.set('call-B', callB);
        coreEvents.emit(CoreEvent.McpProgress, makePayload('call-A', 10));
        coreEvents.emit(CoreEvent.McpProgress, makePayload('call-B', 20));
        expect(mockStateManager.updateStatus).toHaveBeenCalledTimes(2);
        expect(mockStateManager.updateStatus).toHaveBeenCalledWith('call-A', CoreToolCallStatus.Executing, expect.objectContaining({ progress: 10 }));
        expect(mockStateManager.updateStatus).toHaveBeenCalledWith('call-B', CoreToolCallStatus.Executing, expect.objectContaining({ progress: 20 }));
    });
    it('should ignore progress for a callId not in active calls', () => {
        coreEvents.emit(CoreEvent.McpProgress, makePayload('unknown-call', 10));
        expect(mockStateManager.updateStatus).not.toHaveBeenCalled();
    });
    it('should ignore progress for a call in a terminal state', () => {
        const successCall = {
            status: CoreToolCallStatus.Success,
            request: {
                callId: 'call-done',
                name: 'mcp-tool',
                args: {},
                isClientInitiated: false,
                prompt_id: 'p-1',
                schedulerId: ROOT_SCHEDULER_ID,
                parentCallId: undefined,
            },
            tool: { name: 'mcp-tool' },
            response: { callId: 'call-done', responseParts: [] },
        };
        mockActiveCallsMap.set('call-done', successCall);
        coreEvents.emit(CoreEvent.McpProgress, makePayload('call-done', 50));
        expect(mockStateManager.updateStatus).not.toHaveBeenCalled();
    });
    it('should compute validTotal and percentage for determinate progress', () => {
        const call = makeExecutingCall('call-A');
        mockActiveCallsMap.set('call-A', call);
        coreEvents.emit(CoreEvent.McpProgress, makePayload('call-A', 50, { total: 100 }));
        expect(mockStateManager.updateStatus).toHaveBeenCalledWith('call-A', CoreToolCallStatus.Executing, expect.objectContaining({
            progress: 50,
            progressTotal: 100,
            progressPercent: 50,
        }));
    });
});
//# sourceMappingURL=scheduler.test.js.map