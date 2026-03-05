/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scheduleAgentTools } from './agent-scheduler.js';
import { Scheduler } from '../scheduler/scheduler.js';
vi.mock('../scheduler/scheduler.js', () => ({
    Scheduler: vi.fn().mockImplementation(() => ({
        schedule: vi.fn().mockResolvedValue([{ status: 'success' }]),
    })),
}));
describe('agent-scheduler', () => {
    let mockConfig;
    let mockToolRegistry;
    let mockMessageBus;
    beforeEach(() => {
        mockMessageBus = {};
        mockToolRegistry = {
            getTool: vi.fn(),
        };
        mockConfig = {
            getMessageBus: vi.fn().mockReturnValue(mockMessageBus),
            getToolRegistry: vi.fn().mockReturnValue(mockToolRegistry),
        };
    });
    it('should create a scheduler with agent-specific config', async () => {
        const requests = [
            {
                callId: 'call-1',
                name: 'test-tool',
                args: {},
                isClientInitiated: false,
                prompt_id: 'prompt-1',
            },
        ];
        const options = {
            schedulerId: 'subagent-1',
            parentCallId: 'parent-1',
            toolRegistry: mockToolRegistry,
            signal: new AbortController().signal,
        };
        const results = await scheduleAgentTools(mockConfig, requests, options);
        expect(results).toEqual([{ status: 'success' }]);
        expect(Scheduler).toHaveBeenCalledWith(expect.objectContaining({
            schedulerId: 'subagent-1',
            parentCallId: 'parent-1',
            messageBus: mockMessageBus,
        }));
        // Verify that the scheduler's config has the overridden tool registry
        const schedulerConfig = vi.mocked(Scheduler).mock.calls[0][0].config;
        expect(schedulerConfig.getToolRegistry()).toBe(mockToolRegistry);
    });
});
//# sourceMappingURL=agent-scheduler.test.js.map