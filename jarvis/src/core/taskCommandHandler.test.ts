/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { TaskCommandHandler } from "./taskCommandHandler.js";
import { TaskScheduler, type TasksConfig } from "./taskScheduler.js";

vi.mock("node-cron", () => ({
  default: {
    schedule: vi.fn().mockReturnValue({ stop: vi.fn() }),
    validate: vi.fn().mockImplementation((expr: string) => {
      // Simple validation: reject obviously invalid expressions
      return (
        /^[\d\s\*\/,\-]+$/.test(expr) && expr.trim().split(/\s+/).length === 5
      );
    }),
  },
}));

function makeHandler(initialConfig?: Partial<TasksConfig>) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-cmd-"));
  const config: TasksConfig = {
    defaultChannel: "feishu",
    defaultChatId: "oc_default",
    tasks: [],
    ...initialConfig,
  };
  fs.writeFileSync(
    path.join(tmpDir, "tasks.json"),
    JSON.stringify(config, null, 2),
  );

  const scheduler = new TaskScheduler(tmpDir);
  const runNow = vi.fn().mockResolvedValue(undefined);
  const handler = new TaskCommandHandler(scheduler, runNow);
  return { handler, tmpDir, scheduler, runNow };
}

function readTasks(tmpDir: string): TasksConfig {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, "tasks.json"), "utf8"));
}

describe("TaskCommandHandler", () => {
  describe("!task list", () => {
    it("shows default reflection task when no other tasks exist", async () => {
      const { handler } = makeHandler();
      const result = await handler.handle("!task list");
      expect(result).toContain("nightly-reflection");
    });

    it("lists all tasks with their status", async () => {
      const { handler } = makeHandler({
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
      const result = await handler.handle("!task list");
      expect(result).toContain("task1");
      expect(result).toContain("task2");
      expect(result).toContain("✅"); // enabled
      expect(result).toContain("⏸"); // disabled
    });
  });

  describe("!task add", () => {
    it("adds a new task and reloads scheduler", async () => {
      const { handler, tmpDir, scheduler } = makeHandler();
      const reloadSpy = vi.spyOn(scheduler, "reload");
      const result = await handler.handle(
        '!task add "0 8 * * *" "Morning brief"',
      );
      expect(result).toContain("added");
      expect(reloadSpy).toHaveBeenCalledOnce();
      const saved = readTasks(tmpDir);
      const newTask = saved.tasks.find((t) => t.prompt === "Morning brief");
      expect(newTask).toBeDefined();
      expect(newTask!.cron).toBe("0 8 * * *");
      expect(newTask!.enabled).toBe(true);
    });

    it("supports optional --channel and --chat flags", async () => {
      const { handler, tmpDir } = makeHandler();
      await handler.handle(
        '!task add "0 8 * * *" "Brief" --channel wechat --chat user123',
      );
      const saved = readTasks(tmpDir);
      const newTask = saved.tasks.find((t) => t.prompt === "Brief");
      expect(newTask!.channel).toBe("wechat");
      expect(newTask!.chatId).toBe("user123");
    });

    it("returns error for invalid cron expression", async () => {
      const { handler } = makeHandler();
      const result = await handler.handle('!task add "not-a-cron" "Brief"');
      expect(result.toLowerCase()).toContain("invalid");
    });
  });

  describe("!task enable / disable", () => {
    it("enables a disabled task", async () => {
      const { handler, tmpDir, scheduler } = makeHandler({
        tasks: [
          { id: "task1", cron: "0 8 * * *", prompt: "Brief", enabled: false },
        ],
      });
      const reloadSpy = vi.spyOn(scheduler, "reload");
      const result = await handler.handle("!task enable task1");
      expect(result).toContain("enabled");
      expect(reloadSpy).toHaveBeenCalledOnce();
      expect(
        readTasks(tmpDir).tasks.find((t) => t.id === "task1")!.enabled,
      ).toBe(true);
    });

    it("disables an enabled task", async () => {
      const { handler, tmpDir, scheduler } = makeHandler({
        tasks: [
          { id: "task1", cron: "0 8 * * *", prompt: "Brief", enabled: true },
        ],
      });
      const reloadSpy = vi.spyOn(scheduler, "reload");
      const result = await handler.handle("!task disable task1");
      expect(result).toContain("disabled");
      expect(reloadSpy).toHaveBeenCalledOnce();
      expect(
        readTasks(tmpDir).tasks.find((t) => t.id === "task1")!.enabled,
      ).toBe(false);
    });

    it("returns error for unknown task id", async () => {
      const { handler } = makeHandler();
      const result = await handler.handle("!task enable nonexistent");
      expect(result.toLowerCase()).toContain("not found");
    });
  });

  describe("!task delete", () => {
    it("deletes a task and reloads", async () => {
      const { handler, tmpDir, scheduler } = makeHandler({
        tasks: [
          { id: "task1", cron: "0 8 * * *", prompt: "Brief", enabled: true },
        ],
      });
      const reloadSpy = vi.spyOn(scheduler, "reload");
      const result = await handler.handle("!task delete task1");
      expect(result).toContain("deleted");
      expect(reloadSpy).toHaveBeenCalledOnce();
      expect(
        readTasks(tmpDir).tasks.find((t) => t.id === "task1"),
      ).toBeUndefined();
    });
  });

  describe("!task run", () => {
    it("triggers a task immediately via runNow callback", async () => {
      const { handler, runNow } = makeHandler({
        tasks: [
          { id: "task1", cron: "0 8 * * *", prompt: "Brief", enabled: true },
        ],
      });
      const result = await handler.handle("!task run task1");
      expect(result).toContain("triggered");
      expect(runNow).toHaveBeenCalledWith(
        expect.objectContaining({ id: "task1" }),
      );
    });
  });

  describe("!task reload", () => {
    it("calls scheduler.reload() and reports exact task count", async () => {
      const { handler, scheduler } = makeHandler({
        tasks: [
          { id: "task1", cron: "0 8 * * *", prompt: "Brief", enabled: true },
        ],
      });
      const reloadSpy = vi.spyOn(scheduler, "reload");
      const result = await handler.handle("!task reload");
      expect(reloadSpy).toHaveBeenCalledOnce();
      // nightly-reflection built-in + task1 = 2
      expect(result).toContain("2 task(s) registered");
    });

    it("picks up tasks written externally to tasks.json after reload", async () => {
      const { handler, tmpDir } = makeHandler();
      // Write a new task directly to the file (simulating external mutation)
      const config = readTasks(tmpDir);
      config.tasks.push({
        id: "external-task",
        cron: "0 9 * * *",
        prompt: "External",
        enabled: true,
      });
      fs.writeFileSync(
        path.join(tmpDir, "tasks.json"),
        JSON.stringify(config, null, 2),
      );
      await handler.handle("!task reload");
      const listResult = await handler.handle("!task list");
      expect(listResult).toContain("external-task");
    });

    it("warns when reload finds zero tasks (loadConfig failure)", async () => {
      const { handler, tmpDir } = makeHandler();
      // Corrupt tasks.json so loadConfig() returns null
      fs.writeFileSync(path.join(tmpDir, "tasks.json"), "not valid json");
      const result = await handler.handle("!task reload");
      expect(result).toContain("0 tasks found");
    });

    it("works with no user tasks (only built-in nightly-reflection)", async () => {
      const { handler, scheduler } = makeHandler();
      const reloadSpy = vi.spyOn(scheduler, "reload");
      const result = await handler.handle("!task reload");
      expect(reloadSpy).toHaveBeenCalledOnce();
      expect(result).toContain("1 task(s) registered");
    });
  });

  describe("unknown commands", () => {
    it("returns help text for unknown subcommand", async () => {
      const { handler } = makeHandler();
      const result = await handler.handle("!task unknown");
      expect(result.toLowerCase()).toContain("usage");
    });
  });
});

describe("TaskCommandHandler — task_update and natural language cron", () => {
  beforeEach(() => vi.clearAllMocks());

  it("!task update: updates cron of existing task", async () => {
    const { handler, tmpDir, scheduler } = makeHandler({
      tasks: [
        {
          id: "task1",
          cron: "0 8 * * *",
          prompt: "Morning brief",
          enabled: true,
        },
      ],
    });
    const reloadSpy = vi.spyOn(scheduler, "reload");
    const result = await handler.handle(
      '!task update task1 --cron "0 9 * * *"',
    );
    expect(result).toContain("updated");
    expect(reloadSpy).toHaveBeenCalledOnce();
    expect(readTasks(tmpDir).tasks.find((t) => t.id === "task1")!.cron).toBe(
      "0 9 * * *",
    );
  });

  it("!task update: updates prompt", async () => {
    const { handler, tmpDir } = makeHandler({
      tasks: [{ id: "task1", cron: "0 8 * * *", prompt: "Old", enabled: true }],
    });
    await handler.handle('!task update task1 --prompt "New prompt"');
    expect(readTasks(tmpDir).tasks.find((t) => t.id === "task1")!.prompt).toBe(
      "New prompt",
    );
  });

  it("!task update: updates channel and chatId", async () => {
    const { handler, tmpDir } = makeHandler({
      tasks: [
        { id: "task1", cron: "0 8 * * *", prompt: "Brief", enabled: true },
      ],
    });
    await handler.handle("!task update task1 --channel wechat --chat user123");
    const saved = readTasks(tmpDir).tasks.find((t) => t.id === "task1")!;
    expect(saved.channel).toBe("wechat");
    expect(saved.chatId).toBe("user123");
  });

  it("!task update: returns error for unknown task id", async () => {
    const { handler } = makeHandler();
    const result = await handler.handle(
      '!task update nonexistent --cron "0 9 * * *"',
    );
    expect(result.toLowerCase()).toContain("not found");
  });

  it("!task update: returns error for invalid cron", async () => {
    const { handler } = makeHandler({
      tasks: [
        { id: "task1", cron: "0 8 * * *", prompt: "Brief", enabled: true },
      ],
    });
    const result = await handler.handle(
      '!task update task1 --cron "not-a-cron"',
    );
    expect(result.toLowerCase()).toContain("invalid");
  });

  it("!task add: accepts natural language time", async () => {
    const { handler, tmpDir } = makeHandler();
    await handler.handle('!task add "每天早上8点" "Morning brief"');
    expect(
      readTasks(tmpDir).tasks.find((t) => t.prompt === "Morning brief")!.cron,
    ).toBe("0 8 * * *");
  });

  it("!task update: accepts natural language time", async () => {
    const { handler, tmpDir } = makeHandler({
      tasks: [
        { id: "task1", cron: "0 8 * * *", prompt: "Brief", enabled: true },
      ],
    });
    await handler.handle('!task update task1 --cron "每天下午3点"');
    expect(readTasks(tmpDir).tasks.find((t) => t.id === "task1")!.cron).toBe(
      "0 15 * * *",
    );
  });

  it("handleTool: reload is intentionally not exposed as an LLM tool action", async () => {
    const { handler } = makeHandler();
    const result = await handler.handleTool("reload", {});
    expect(result).toContain("Unknown task action");
  });
});
