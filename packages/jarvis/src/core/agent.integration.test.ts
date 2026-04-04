/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { JarvisAgent } from './agent.js';

describe('JarvisAgent Integration - Proactive System', () => {
  it('should implement setTaskCommandHandler', async () => {
    const agent = new JarvisAgent({
      sessionId: 'jarvis-global',
      cwd: process.cwd(),
      memoryService: { searchFacts: vi.fn().mockResolvedValue([]) } as any
    });

    const mockHandler = { handleTool: vi.fn() } as any;
    
    // Expect this method to exist and NOT throw
    expect(() => agent.setTaskCommandHandler(mockHandler)).not.toThrow();
  });

  it('should include PROACTIVE protocol when sessionId starts with cron-', async () => {
    const agent = new JarvisAgent({
      sessionId: 'cron-task-123',
      cwd: process.cwd(),
      memoryService: { searchFacts: vi.fn().mockResolvedValue([]) } as any
    });

    // We can't easily trigger the full initialize/client chain without mocks,
    // but we can check if the logic exists in refreshContext via spying on client.getChat
    
    const mockChat = { setSystemInstruction: vi.fn(), getHistory: vi.fn().mockReturnValue([]) };
    (agent as any).client = { 
      getChat: () => mockChat, 
      config: { 
        getUserMemory: () => ({}),
        isInteractive: () => false,
        getSkillManager: () => ({
          getSkills: () => []
        }),
        getToolRegistry: () => ({
          getTools: () => [],
          getAllToolNames: () => []
        }),
        getApprovedPlanPath: () => undefined,
        getActiveModel: () => 'gemini-2.5-flash',
        getAgentRegistry: () => ({
          getAgents: () => [],
          getAllDefinitions: () => []
        }),
        getEnableShellOutputEfficiency: () => true,
        isInteractiveShellEnabled: () => false,
        storage: {
          getProjectTempDir: () => process.cwd()
        }
      } 
    };

    await (agent as any).refreshContext('test');

    const instruction = mockChat.setSystemInstruction.mock.calls[0][0];
    expect(instruction).toContain('MISSION CRITICAL (PROACTIVE MODE)');
    expect(instruction).toContain('deliver_result');
  });
});
