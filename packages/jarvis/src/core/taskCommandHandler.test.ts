/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { TaskCommandHandler } from './taskCommandHandler.js';
import type { TasksConfig } from './taskScheduler.js';

vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn().mockReturnValue({ stop: vi.fn() }),
    validate: vi.fn().mockImplementation((expr: string) => {
      // Simple validation: reject obviously invalid expressions
      return /^[\d\s\*\/,\-]+$/.test(expr) && expr.trim().split(/\s+/).length === 5;
    }),
  },
}));

function makeHandler(initialConfig?: Partial<TasksConfig>) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-cmd-'));
  const config: TasksConfig = {
    defaultChannel: 'feishu',
    defaultChatId: 'oc_default',
    tasks: [],
    ...initialConfig,
  };
  fs.writeFileSync(path.join(tmpDir, 'tasks.json'), JSON.stringify(config, null, 2));

  const reload = vi.fn();
  const runNow = vi.fn().mockResolvedValue(undefined);
  const handler = new TaskCommandHandler(tmpDir, reload, runNow);
  return { handler, tmpDir, reload, runNow };
}

function readTasks(tmpDir: string): TasksConfig {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, 'tasks.json'), 'utf8'));
}

describe('TaskCommandHandler', () => {
  describe('/task list', () => {
    it('shows empty message when no tasks exist', async () => {
      const { handler } = makeHandler();
      const result = await handler.handle('/task list');
      expect(result).toContain('No tasks');
    });

    it('lists all tasks with their status', async () => {
      const { handler } = makeHandler({
        tasks: [
          { id: 'task1', cron: '0 8 * * *', prompt: 'Morning brief', enabled: true },
          { id: 'task2', cron: '0 22 * * *', prompt: 'Evening report', enabled: false },
        ],
      });
      const result = await handler.handle('/task list');
      expect(result).toContain('task1');
      expect(result).toContain('task2');
      expect(result).toContain('✅');  // enabled
      expect(result).toContain('⏸');  // disabled
    });
  });

  describe('/task add', () => {
    it('adds a new task and reloads scheduler', async () => {
      const { handler, tmpDir, reload } = makeHandler();
      const result = await handler.handle('/task add "0 8 * * *" "Morning brief"');
      expect(result).toContain('added');
      expect(reload).toHaveBeenCalledOnce();
      const saved = readTasks(tmpDir);
      expect(saved.tasks).toHaveLength(1);
      expect(saved.tasks[0].cron).toBe('0 8 * * *');
      expect(saved.tasks[0].prompt).toBe('Morning brief');
      expect(saved.tasks[0].enabled).toBe(true);
    });

    it('supports optional --channel and --chat flags', async () => {
      const { handler, tmpDir } = makeHandler();
      await handler.handle('/task add "0 8 * * *" "Brief" --channel wechat --chat user123');
      const saved = readTasks(tmpDir);
      expect(saved.tasks[0].channel).toBe('wechat');
      expect(saved.tasks[0].chatId).toBe('user123');
    });

    it('returns error for invalid cron expression', async () => {
      const { handler } = makeHandler();
      const result = await handler.handle('/task add "not-a-cron" "Brief"');
      expect(result.toLowerCase()).toContain('invalid');
    });
  });

  describe('/task enable / disable', () => {
    it('enables a disabled task', async () => {
      const { handler, tmpDir, reload } = makeHandler({
        tasks: [{ id: 'task1', cron: '0 8 * * *', prompt: 'Brief', enabled: false }],
      });
      const result = await handler.handle('/task enable task1');
      expect(result).toContain('enabled');
      expect(reload).toHaveBeenCalledOnce();
      expect(readTasks(tmpDir).tasks[0].enabled).toBe(true);
    });

    it('disables an enabled task', async () => {
      const { handler, tmpDir, reload } = makeHandler({
        tasks: [{ id: 'task1', cron: '0 8 * * *', prompt: 'Brief', enabled: true }],
      });
      const result = await handler.handle('/task disable task1');
      expect(result).toContain('disabled');
      expect(reload).toHaveBeenCalledOnce();
      expect(readTasks(tmpDir).tasks[0].enabled).toBe(false);
    });

    it('returns error for unknown task id', async () => {
      const { handler } = makeHandler();
      const result = await handler.handle('/task enable nonexistent');
      expect(result.toLowerCase()).toContain('not found');
    });
  });

  describe('/task delete', () => {
    it('deletes a task and reloads', async () => {
      const { handler, tmpDir, reload } = makeHandler({
        tasks: [{ id: 'task1', cron: '0 8 * * *', prompt: 'Brief', enabled: true }],
      });
      const result = await handler.handle('/task delete task1');
      expect(result).toContain('deleted');
      expect(reload).toHaveBeenCalledOnce();
      expect(readTasks(tmpDir).tasks).toHaveLength(0);
    });
  });

  describe('/task run', () => {
    it('triggers a task immediately via runNow callback', async () => {
      const { handler, runNow } = makeHandler({
        tasks: [{ id: 'task1', cron: '0 8 * * *', prompt: 'Brief', enabled: true }],
      });
      const result = await handler.handle('/task run task1');
      expect(result).toContain('triggered');
      expect(runNow).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'task1' }),
      );
    });
  });

  describe('unknown commands', () => {
    it('returns help text for unknown subcommand', async () => {
      const { handler } = makeHandler();
      const result = await handler.handle('/task unknown');
      expect(result.toLowerCase()).toContain('usage');
    });
  });
});
