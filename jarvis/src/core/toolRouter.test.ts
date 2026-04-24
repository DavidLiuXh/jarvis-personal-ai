/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../../core/src/index.js", () => ({
  recordToolCallInteractions: vi.fn().mockResolvedValue(undefined),
}));

import { ToolRouter } from "./toolRouter.js";

describe("ToolRouter", () => {
  const makeReq = (name: string, args: Record<string, unknown> = {}) => ({
    name,
    args,
    callId: `call-${name}`,
  });

  const makeRouter = (
    overrides: {
      saveFact?: ReturnType<typeof vi.fn>;
      search?: ReturnType<typeof vi.fn>;
      searchFacts?: ReturnType<typeof vi.fn>;
      runSkill?: ReturnType<typeof vi.fn>;
      schedule?: ReturnType<typeof vi.fn>;
      pushSafe?: ReturnType<typeof vi.fn>;
      handleTool?: ReturnType<typeof vi.fn>;
    } = {},
  ) => {
    const saveFact = overrides.saveFact ?? vi.fn().mockResolvedValue(undefined);
    const search = overrides.search ?? vi.fn().mockResolvedValue([]);
    const searchFacts = overrides.searchFacts ?? vi.fn().mockResolvedValue([]);
    const runSkill = overrides.runSkill ?? vi.fn();
    const schedule = overrides.schedule ?? vi.fn().mockResolvedValue([]);
    const getModel = vi.fn().mockReturnValue("gemini-pro");
    const getChat = vi
      .fn()
      .mockReturnValue({ getModel, recordCompletedToolCalls: vi.fn() });
    const getCurrentSequenceModel = vi.fn().mockReturnValue(null);
    const config = { api: { apiVersion: "v1alpha" } };
    const pushSafe = overrides.pushSafe ?? vi.fn().mockResolvedValue(true);
    const handleTool = overrides.handleTool ?? vi.fn().mockResolvedValue("ok");

    const router = new ToolRouter(
      { saveFact, search, searchFacts },
      { runSkill },
      { schedule },
      { getChat, getCurrentSequenceModel, config } as any,
      { handleTool } as any,
      { pushSafe } as any,
    );
    return {
      router,
      saveFact,
      search,
      searchFacts,
      schedule,
      pushSafe,
      handleTool,
    };
  };

  it("routes save_memory (fact arg) with category-based importance", async () => {
    const { router, saveFact } = makeRouter();

    const onToolResponse = vi.fn();
    const req = makeReq("save_memory", { fact: "user likes TypeScript" });
    const parts = await router.route(
      [req],
      new AbortController().signal,
      onToolResponse,
    );

    // preference category → importance 7
    expect(saveFact).toHaveBeenCalledWith(
      "preference",
      "user likes TypeScript",
      7,
    );
    expect(parts).toHaveLength(1);
    expect((parts[0] as any).functionResponse.name).toBe("save_memory");
  });

  it("save_memory uses category arg when provided", async () => {
    const { router, saveFact } = makeRouter();

    const req = makeReq("save_memory", {
      fact: "user is a software engineer",
      category: "identity",
    });
    await router.route([req], new AbortController().signal, vi.fn());

    // identity category → importance 9
    expect(saveFact).toHaveBeenCalledWith(
      "identity",
      "user is a software engineer",
      9,
    );
  });

  it("save_memory falls back to request arg (gemini-cli MemoryManagerAgent compat)", async () => {
    const { router, saveFact } = makeRouter();

    const req = makeReq("save_memory", {
      request: "Remember: user prefers TypeScript",
    });
    await router.route([req], new AbortController().signal, vi.fn());

    expect(saveFact).toHaveBeenCalledWith(
      "preference",
      "Remember: user prefers TypeScript",
      7,
    );
  });

  it("save_memory importance by category: specification=8, behavior=7", async () => {
    const { router, saveFact } = makeRouter();

    await router.route(
      [
        makeReq("save_memory", {
          fact: "project uses monorepo",
          category: "specification",
        }),
      ],
      new AbortController().signal,
      vi.fn(),
    );
    expect(saveFact).toHaveBeenCalledWith(
      "specification",
      "project uses monorepo",
      8,
    );

    saveFact.mockClear();
    await router.route(
      [
        makeReq("save_memory", {
          fact: "user runs daily",
          category: "behavior",
        }),
      ],
      new AbortController().signal,
      vi.fn(),
    );
    expect(saveFact).toHaveBeenCalledWith("behavior", "user runs daily", 7);
  });

  it("routes recall_memory to memoryService.search", async () => {
    const search = vi
      .fn()
      .mockResolvedValue(["memory item 1", "memory item 2"]);
    const { router } = makeRouter({ search });

    const req = makeReq("recall_memory", { query: "TypeScript", limit: 3 });
    const parts = await router.route(
      [req],
      new AbortController().signal,
      vi.fn(),
    );

    expect(search).toHaveBeenCalledWith("TypeScript", 3);
    expect(parts).toHaveLength(1);
    const response = (parts[0] as any).functionResponse.response;
    expect(JSON.stringify(response)).toContain("memory item 1");
  });

  it("routes evolved skills to dynamicRegistry.runSkill", async () => {
    const runSkill = vi.fn().mockResolvedValue("skill output");
    const { router } = makeRouter({ runSkill });

    const req = makeReq("run_evolved_skill_my_skill", { input: "test" });
    const parts = await router.route(
      [req],
      new AbortController().signal,
      vi.fn(),
    );

    expect(runSkill).toHaveBeenCalledWith("run_evolved_skill_my_skill", {
      input: "test",
    });
    expect(parts).toHaveLength(1);
  });

  it("delegates standard tool calls to scheduler", async () => {
    const completedCall = {
      request: { name: "read_file", callId: "call-read_file" },
      status: "success",
      response: {
        responseParts: [{ text: "file content" }],
        resultDisplay: "file content",
      },
    };
    const schedule = vi.fn().mockResolvedValue([completedCall]);
    const { router } = makeRouter({ schedule });

    const onToolResponse = vi.fn();
    const req = makeReq("read_file", { path: "/some/file" });
    const parts = await router.route(
      [req],
      new AbortController().signal,
      onToolResponse,
    );

    expect(schedule).toHaveBeenCalledWith([req], expect.any(AbortSignal));
    expect(parts).toHaveLength(1);
    expect(onToolResponse).toHaveBeenCalledWith({
      name: "read_file",
      status: "success",
      output: "file content",
      callId: "call-read_file",
    });
  });

  it("routes task_list to taskCommandHandler.handleTool", async () => {
    const handleTool = vi.fn().mockResolvedValue("📋 Tasks: none");
    const { router } = makeRouter({ handleTool });

    const req = makeReq("task_list", {});
    const parts = await router.route(
      [req],
      new AbortController().signal,
      vi.fn(),
    );

    expect(handleTool).toHaveBeenCalledWith("list", {});
    expect(parts).toHaveLength(1);
    expect((parts[0] as any).functionResponse.name).toBe("task_list");
  });

  it("routes task_add to taskCommandHandler.handleTool with args", async () => {
    const handleTool = vi.fn().mockResolvedValue("✅ Task added");
    const { router } = makeRouter({ handleTool });

    const req = makeReq("task_add", {
      cron: "0 8 * * *",
      prompt: "Morning brief",
    });
    await router.route([req], new AbortController().signal, vi.fn());

    expect(handleTool).toHaveBeenCalledWith("add", {
      cron: "0 8 * * *",
      prompt: "Morning brief",
    });
  });

  it("intercepts ask_user and returns auto-selected option with user-facing message", async () => {
    const { router, schedule } = makeRouter();

    const questions = [
      {
        question: "Where should I create worktrees?",
        header: "Worktree Location",
        options: [
          {
            label: ".worktrees/",
            description: "Project-local, hidden (recommended)",
          },
          {
            label: "~/.config/superpowers/worktrees/",
            description: "Global location",
          },
        ],
      },
    ];

    const req = {
      name: "ask_user",
      args: { questions },
      callId: "call-ask_user",
    };
    const parts = await router.route(
      [req],
      new AbortController().signal,
      vi.fn(),
    );

    expect(schedule).not.toHaveBeenCalled();
    expect(parts).toHaveLength(1);
    const response = JSON.stringify(
      (parts[0] as any).functionResponse.response,
    );
    expect(response).toContain("Where should I create worktrees?");
    expect(response).toContain(".worktrees/");
    expect(response).toContain("~/.config/superpowers/worktrees/");
    expect(response.toLowerCase()).toMatch(/recommended|auto.selected|default/);
    expect(response.toLowerCase()).toMatch(/inform|tell.*user|let.*user know/);
  });

  it("routes push_to_channel to channelRegistry.pushSafe", async () => {
    const pushSafe = vi.fn().mockResolvedValue(true);
    const { router, schedule } = makeRouter({ pushSafe });

    const req = makeReq("push_to_channel", {
      channel: "wechat",
      content: "Hello from Jarvis",
    });
    const parts = await router.route(
      [req],
      new AbortController().signal,
      vi.fn(),
    );

    expect(pushSafe).toHaveBeenCalledWith("wechat", "", "Hello from Jarvis");
    expect(schedule).not.toHaveBeenCalled();
    expect(parts).toHaveLength(1);
  });

  it("push_to_channel passes chat_id when provided", async () => {
    const pushSafe = vi.fn().mockResolvedValue(true);
    const { router } = makeRouter({ pushSafe });

    const req = makeReq("push_to_channel", {
      channel: "feishu",
      content: "Report",
      chat_id: "oc_123",
    });
    await router.route([req], new AbortController().signal, vi.fn());

    expect(pushSafe).toHaveBeenCalledWith("feishu", "oc_123", "Report");
  });
});
