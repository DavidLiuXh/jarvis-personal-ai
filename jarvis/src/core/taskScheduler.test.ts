/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

vi.mock("node-cron", () => ({
  default: {
    schedule: vi.fn().mockReturnValue({ stop: vi.fn() }),
    validate: vi.fn().mockReturnValue(true),
  },
}));

import {
  TaskScheduler,
  type TaskConfig,
  type TasksConfig,
} from "./taskScheduler.js";

function writeTasks(dir: string, config: TasksConfig) {
  fs.writeFileSync(
    path.join(dir, "tasks.json"),
    JSON.stringify(config, null, 2),
  );
}

describe("TaskScheduler", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tasks-"));
    vi.clearAllMocks();
  });

  it("loads tasks from tasks.json and registers enabled ones", async () => {
    const cron = await import("node-cron");
    writeTasks(tmpDir, {
      defaultChannel: "feishu",
      defaultChatId: "oc_test",
      tasks: [
        {
          id: "task1",
          cron: "0 8 * * *",
          prompt: "Morning brief",
          enabled: true,
        },
        {
          id: "task2",
          cron: "0 22 * * *",
          prompt: "Evening report",
          enabled: false,
        },
      ],
    });

    const scheduler = new TaskScheduler(tmpDir);
    scheduler.start();

    // Only enabled tasks should be scheduled
    expect(cron.default.schedule as any).toHaveBeenCalledTimes(1);
    expect((cron.default.schedule as any).mock.calls[0][0]).toBe("0 8 * * *");
  });

  it("initializes with default reflection task when tasks.json does not exist", () => {
    const scheduler = new TaskScheduler(tmpDir);
    const tasks = scheduler.getTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("nightly-reflection");
    expect(tasks[0].type).toBe("reflect");
  });

  it("calls onTrigger callback when a task fires", async () => {
    const cron = await import("node-cron");
    let capturedCallback: (() => void) | null = null;
    (cron.default.schedule as any).mockImplementation(
      (_expr: string, cb: () => void) => {
        capturedCallback = cb;
        return { stop: vi.fn() };
      },
    );

    writeTasks(tmpDir, {
      defaultChannel: "feishu",
      defaultChatId: "oc_test",
      tasks: [
        {
          id: "task1",
          cron: "0 8 * * *",
          prompt: "Morning brief",
          enabled: true,
        },
      ],
    });

    const onTrigger = vi.fn();
    const scheduler = new TaskScheduler(tmpDir);
    scheduler.onTrigger(onTrigger);
    scheduler.start();

    // Simulate cron firing
    capturedCallback!();

    expect(onTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task1", prompt: "Morning brief" }),
    );
  });

  it("uses task-level chatId over default when specified", async () => {
    const cron = await import("node-cron");
    let capturedCallback: (() => void) | null = null;
    (cron.default.schedule as any).mockImplementation(
      (_expr: string, cb: () => void) => {
        capturedCallback = cb;
        return { stop: vi.fn() };
      },
    );

    writeTasks(tmpDir, {
      defaultChannel: "feishu",
      defaultChatId: "oc_default",
      tasks: [
        {
          id: "task1",
          cron: "0 8 * * *",
          prompt: "Brief",
          enabled: true,
          chatId: "oc_custom",
        },
      ],
    });

    const onTrigger = vi.fn();
    const scheduler = new TaskScheduler(tmpDir);
    scheduler.onTrigger(onTrigger);
    scheduler.start();
    capturedCallback!();

    expect(onTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "oc_custom" }),
    );
  });

  it("stop() cancels all scheduled tasks", async () => {
    const stopFn = vi.fn();
    const cron = await import("node-cron");
    (cron.default.schedule as any).mockReturnValue({ stop: stopFn });

    writeTasks(tmpDir, {
      defaultChannel: "feishu",
      defaultChatId: "oc_test",
      tasks: [
        { id: "task1", cron: "0 8 * * *", prompt: "Brief", enabled: true },
      ],
    });

    const scheduler = new TaskScheduler(tmpDir);
    scheduler.start();
    scheduler.stop();

    expect(stopFn).toHaveBeenCalledOnce();
  });
});
