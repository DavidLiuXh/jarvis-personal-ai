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
import type { MemoryContract } from "../memory-runtime/index.js";

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

  const memoryContract = (
    overrides: Partial<MemoryContract> = {},
  ): MemoryContract => ({
    needMemory: true,
    subjectBoundary: "personal",
    targetScopes: ["fact", "entry"],
    memoryTarget: "conversation_history",
    query: {
      raw: "summarize previous TypeScript discussion",
      rewritten: "TypeScript discussion",
      entities: ["TypeScript"],
    },
    confidence: {
      subject: 0.95,
      target: 0.9,
      query: 0.9,
    },
    constraints: {
      allowPersonalFacts: true,
      allowSessionHistory: true,
      allowEntries: true,
      maxChars: 1800,
    },
    reasons: ["test"],
    policyTrace: [],
    ...overrides,
  });

  it("routes save_memory (fact arg) with two-factor importance formula", async () => {
    const { router, saveFact } = makeRouter();

    const req = makeReq("save_memory", { fact: "user likes TypeScript" });
    const parts = await router.route(
      [req],
      new AbortController().signal,
      vi.fn(),
    );

    expect(saveFact).toHaveBeenCalledOnce();
    const [cat, , imp] = saveFact.mock.calls[0];
    // interaction_style category, no remember-intent → 0.7*7 + 0.3*6 = 4.9+1.8 = 6.7 → 7
    expect(cat).toBe("interaction_style");
    expect(imp).toBe(7);
    expect(parts).toHaveLength(1);
    expect((parts[0] as any).functionResponse.name).toBe("save_memory");
  });

  it("save_memory: explicit remember-intent raises importance", async () => {
    const { router, saveFact } = makeRouter();

    // "记住这个" triggers remember_intent=9
    // interaction_style: 0.7*7 + 0.3*9 = 4.9+2.7 = 7.6 → 8
    const req = makeReq("save_memory", { fact: "记住这个：用中文回答" });
    await router.route([req], new AbortController().signal, vi.fn());

    const [, , imp] = saveFact.mock.calls[0];
    expect(imp).toBe(8);
  });

  it("save_memory: identity category has higher base importance", async () => {
    const { router, saveFact } = makeRouter();

    const req = makeReq("save_memory", {
      fact: "user is a software engineer",
      category: "identity",
    });
    await router.route([req], new AbortController().signal, vi.fn());

    const [cat, , imp] = saveFact.mock.calls[0];
    expect(cat).toBe("identity");
    // identity: 0.7*9 + 0.3*6 = 6.3+1.8 = 8.1 → 8
    expect(imp).toBe(8);
  });

  it("save_memory: prefix form 'Remember: ...' triggers high intent", async () => {
    // The most common compat-path format — anchored prefix must be detected
    const { router, saveFact } = makeRouter();
    const req = makeReq("save_memory", {
      request: "Remember: user prefers TypeScript over JavaScript",
    });
    await router.route([req], new AbortController().signal, vi.fn());
    const [, , imp] = saveFact.mock.calls[0];
    // rememberIntent=9 → interaction_style: 0.7*7 + 0.3*9 = 7.6 → 8
    expect(imp).toBe(8);
  });

  it("save_memory: prefix variant 'remember - ...' triggers high intent", async () => {
    const { router, saveFact } = makeRouter();
    const req = makeReq("save_memory", {
      request: "remember - use Chinese for all replies",
    });
    await router.route([req], new AbortController().signal, vi.fn());
    const [, , imp] = saveFact.mock.calls[0];
    expect(imp).toBe(8);
  });

  it("save_memory: in-sentence 'Remember that ...' triggers high intent", async () => {
    const { router, saveFact } = makeRouter();
    const req = makeReq("save_memory", {
      request: "Remember that I prefer TypeScript over JavaScript",
    });
    await router.route([req], new AbortController().signal, vi.fn());
    const [, , imp] = saveFact.mock.calls[0];
    // "remember that" matches in-sentence pattern → rememberIntent=9
    expect(imp).toBe(8);
  });

  it("save_memory: mid-sentence 'I remember: ...' does NOT trigger intent (not anchored)", async () => {
    // "I remember: we used TypeScript" is a recall statement, not a command
    const { router, saveFact } = makeRouter();
    const req = makeReq("save_memory", {
      request: "I remember: we used TypeScript in the last project",
    });
    await router.route([req], new AbortController().signal, vi.fn());
    const [, , imp] = saveFact.mock.calls[0];
    // No intent detected → rememberIntent=6 → interaction_style: 0.7*7 + 0.3*6 = 6.7 → 7
    expect(imp).toBe(7);
  });

  it("save_memory fact arg without remember-intent uses neutral score", async () => {
    const { router, saveFact } = makeRouter();
    const req = makeReq("save_memory", { fact: "user prefers TypeScript" });
    await router.route([req], new AbortController().signal, vi.fn());
    const [, , imp] = saveFact.mock.calls[0];
    // interaction_style: 0.7*7 + 0.3*6 = 4.9+1.8 = 6.7 → 7
    expect(imp).toBe(7);
  });

  it("save_memory importance is always in [1, 10]", async () => {
    const { router, saveFact } = makeRouter();

    for (const category of [
      "identity",
      "specification",
      "behavior",
      "interaction_style",
    ]) {
      saveFact.mockClear();
      await router.route(
        [makeReq("save_memory", { fact: "some fact", category })],
        new AbortController().signal,
        vi.fn(),
      );
      const [, , imp] = saveFact.mock.calls[0];
      expect(imp).toBeGreaterThanOrEqual(1);
      expect(imp).toBeLessThanOrEqual(10);
    }
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

    expect(search).toHaveBeenCalledWith("TypeScript", 3, null, null);
    expect(parts).toHaveLength(1);
    const response = (parts[0] as any).functionResponse.response;
    expect(JSON.stringify(response)).toContain("memory item 1");
  });

  it("recall_memory is denied when the MemoryContract forbids personal entries", async () => {
    const search = vi.fn().mockResolvedValue(["should not be read"]);
    const { router } = makeRouter({ search });
    router.setCurrentMemoryContract(
      memoryContract({
        needMemory: false,
        subjectBoundary: "external",
        targetScopes: [],
        memoryTarget: "external_past_event",
        constraints: {
          allowPersonalFacts: false,
          allowSessionHistory: false,
          allowEntries: false,
          maxChars: 1800,
        },
        reasons: ["external_past_event"],
      }),
    );

    const parts = await router.route(
      [makeReq("recall_memory", { query: "Apple launch" })],
      new AbortController().signal,
      vi.fn(),
    );

    expect(search).not.toHaveBeenCalled();
    const response = JSON.stringify(
      (parts[0] as any).functionResponse.response,
    );
    expect(response).toContain("PERSONAL MEMORY ACCESS DENIED");
  });

  it("recall_memory: derives topic keywords when LLM sends an empty query", async () => {
    const search = vi.fn().mockResolvedValue(["market research result"]);
    const { router } = makeRouter({ search });

    router.setCurrentUserPrompt(
      "还记得之前market reaearch ecommerce ai相关的讨论吗？",
    );

    const req = makeReq("recall_memory", { query: "" });
    await router.route([req], new AbortController().signal, vi.fn());

    expect(search).toHaveBeenCalledWith(
      "market reaearch ecommerce ai",
      5,
      null,
      null,
    );
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

  it("injects subagent memory only through the current MemoryContract", async () => {
    const searchFacts = vi
      .fn()
      .mockResolvedValue([{ category: "preference", content: "likes TS" }]);
    const search = vi.fn().mockResolvedValue(["previous TS discussion"]);
    const schedule = vi.fn().mockResolvedValue([]);
    const { router } = makeRouter({ searchFacts, search, schedule });
    router.setCurrentMemoryContract(memoryContract());

    const req = makeReq("generalist", {
      request: "Summarize the TypeScript direction",
    });
    await router.route([req], new AbortController().signal, vi.fn());

    expect(searchFacts).toHaveBeenCalledWith("TypeScript discussion");
    expect(search).toHaveBeenCalledWith("TypeScript discussion", 3, null, null);
    const scheduled = schedule.mock.calls[0][0][0];
    expect(scheduled.args.request).toContain("<memory_decision>");
    expect(scheduled.args.request).toContain("<jarvis_memory>");
    expect(scheduled.args.request).toContain("<relevant_past_conversations>");
  });

  it("does not inject personal memory into subagents for external contracts", async () => {
    const searchFacts = vi.fn().mockResolvedValue([]);
    const search = vi.fn().mockResolvedValue([]);
    const schedule = vi.fn().mockResolvedValue([]);
    const { router } = makeRouter({ searchFacts, search, schedule });
    router.setCurrentMemoryContract(
      memoryContract({
        needMemory: false,
        subjectBoundary: "external",
        targetScopes: [],
        memoryTarget: "none",
        constraints: {
          allowPersonalFacts: false,
          allowSessionHistory: false,
          allowEntries: false,
          maxChars: 1800,
        },
        reasons: ["external_subject"],
      }),
    );

    const req = makeReq("codebase_investigator", {
      request: "Analyze HTTP cache semantics",
    });
    await router.route([req], new AbortController().signal, vi.fn());

    expect(searchFacts).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    const scheduled = schedule.mock.calls[0][0][0];
    expect(scheduled.args.request).toContain("subject: external");
    expect(scheduled.args.request).toContain(
      "Do not use or infer personal memory",
    );
    expect(scheduled.args.request).not.toContain("<jarvis_memory>");
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

  it("rewrites shell cron scheduling workarounds to Jarvis task_add", async () => {
    const handleTool = vi.fn().mockResolvedValue("✅ Task added");
    const schedule = vi.fn().mockResolvedValue([]);
    const { router } = makeRouter({ handleTool, schedule });
    router.setCurrentUserPrompt(
      "添加一个定时任务：北京时间每周五下午2点，使用dmii框架分析美国市场行情及趋势，保存成本地的markdown文件",
    );

    await router.route(
      [
        makeReq("run_shell_command", {
          command:
            '(crontab -l; echo "0 14 * * 5 /usr/local/bin/market-report") | crontab -',
          description: "Create a system cron job",
        }),
      ],
      new AbortController().signal,
      vi.fn(),
    );

    expect(schedule).not.toHaveBeenCalled();
    expect(handleTool).toHaveBeenCalledWith("add", {
      cron: "北京时间每周五下午2点",
      prompt: "使用dmii框架分析美国市场行情及趋势，保存成本地的markdown文件",
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

  it("push_to_channel derives channel from current user prompt when arg is missing", async () => {
    const pushSafe = vi.fn().mockResolvedValue(true);
    const { router } = makeRouter({ pushSafe });

    router.setCurrentUserPrompt("将上述关于dcf的内容推送到wechat");

    const req = makeReq("push_to_channel", {
      content: "DCF summary",
    });
    await router.route([req], new AbortController().signal, vi.fn());

    expect(pushSafe).toHaveBeenCalledWith("wechat", "", "DCF summary");
  });

  it("push_to_channel normalizes localized channel aliases", async () => {
    const pushSafe = vi.fn().mockResolvedValue(true);
    const { router } = makeRouter({ pushSafe });

    const req = makeReq("push_to_channel", {
      channel: "微信",
      content: "Hello",
    });
    await router.route([req], new AbortController().signal, vi.fn());

    expect(pushSafe).toHaveBeenCalledWith("wechat", "", "Hello");
  });

  it("push_to_channel returns a clear error when channel cannot be inferred", async () => {
    const pushSafe = vi.fn().mockResolvedValue(true);
    const { router } = makeRouter({ pushSafe });

    const req = makeReq("push_to_channel", {
      content: "Hello",
    });
    const parts = await router.route(
      [req],
      new AbortController().signal,
      vi.fn(),
    );

    expect(pushSafe).not.toHaveBeenCalled();
    expect(
      JSON.stringify((parts[0] as any).functionResponse.response),
    ).toContain("push_to_channel requires a target channel");
  });

  it("builds a push_to_channel request from generated content for explicit channel push prompts", () => {
    const { router } = makeRouter();

    router.setCurrentUserPrompt("把这段总结推送到微信");

    const req = router.buildPushToChannelRequestFromContent(
      "### Summary\n\nContent body",
      "auto-call-1",
    );

    expect(req).toEqual({
      name: "push_to_channel",
      callId: "auto-call-1",
      args: {
        channel: "wechat",
        content: "### Summary\n\nContent body",
        chat_id: "",
      },
    });
  });

  it("does not build a push_to_channel request when prompt has no channel target", () => {
    const { router } = makeRouter();

    router.setCurrentUserPrompt("整理一下这段内容");

    expect(
      router.buildPushToChannelRequestFromContent("Content body"),
    ).toBeNull();
  });

  it("rewrites shell clipboard workaround to push_to_channel for channel push requests", async () => {
    const pushSafe = vi.fn().mockResolvedValue(true);
    const schedule = vi.fn().mockResolvedValue([]);
    const { router } = makeRouter({ pushSafe, schedule });

    router.setCurrentUserPrompt("将上述 AI 行业动态推送到微信");

    const req = makeReq("run_shell_command", {
      command:
        'echo "### AI 行业动态\\n\\n**总结**：进入智能体时代。" | pbcopy',
      description: "将动态内容复制到剪贴板以便用户手动粘贴。",
    });
    await router.route([req], new AbortController().signal, vi.fn());

    expect(schedule).not.toHaveBeenCalled();
    expect(pushSafe).toHaveBeenCalledWith(
      "wechat",
      "",
      "### AI 行业动态\n\n**总结**：进入智能体时代。",
    );
  });

  it("recall_memory: router-set dateRange used as fallback when LLM omits date params", async () => {
    const search = vi.fn().mockResolvedValue(["monday result"]);
    const { router } = makeRouter({ search });

    // Simulate router having classified "周一" → exact date
    // Pass pre-resolved DateRange directly (as extractDateRange would produce)
    router.setCurrentDateRange({
      from: new Date(2026, 3, 27, 0, 0, 0, 0).getTime(),
      to: new Date(2026, 3, 28, 0, 0, 0, 0).getTime(),
    });

    // LLM calls recall_memory without date_from/date_to
    const req = makeReq("recall_memory", { query: "discussion" });
    await router.route([req], new AbortController().signal, vi.fn());

    const [, , twDays, dateRange] = search.mock.calls[0];
    expect(twDays).toBeNull();
    expect(dateRange).not.toBeNull();
    // from = 2026-04-27 00:00 local, to = 2026-04-28 00:00 local
    expect(dateRange.from).toBe(new Date(2026, 3, 27, 0, 0, 0, 0).getTime());
    expect(dateRange.to).toBe(new Date(2026, 3, 28, 0, 0, 0, 0).getTime());
  });

  it("recall_memory: date_from/date_to ISO strings are parsed into dateRange", async () => {
    const search = vi.fn().mockResolvedValue(["result about investment"]);
    const { router } = makeRouter({ search });

    const req = makeReq("recall_memory", {
      query: "investment",
      date_from: "2026-04-27",
      date_to: "2026-04-27",
    });
    await router.route([req], new AbortController().signal, vi.fn());

    const [q, limit, twDays, dateRange] = search.mock.calls[0];
    expect(q).toBe("investment");
    expect(limit).toBe(5);
    expect(twDays).toBeNull();
    expect(dateRange).not.toBeNull();
    expect(dateRange.from).toBe(new Date("2026-04-27").getTime());
    // date-only date_to → exclusive upper bound (start of next day)
    expect(dateRange.to).toBe(new Date("2026-04-28").getTime());
  });

  it("recall_memory: invalid date_from/date_to falls back to null dateRange", async () => {
    const search = vi.fn().mockResolvedValue([]);
    const { router } = makeRouter({ search });

    const req = makeReq("recall_memory", {
      query: "test",
      date_from: "not-a-date",
      date_to: "also-bad",
    });
    await router.route([req], new AbortController().signal, vi.fn());

    const [, , , dateRange] = search.mock.calls[0];
    expect(dateRange).toBeNull();
  });

  // ── ask_user async handler ──────────────────────────────────────────────────

  it("ask_user: calls askUserHandler and returns formatted answers to LLM", async () => {
    const { router } = makeRouter();
    const questions = [
      { question: "分析框架是什么？", header: "分析框架" },
      { question: "具体事件是什么？", header: "事件详情" },
    ];

    const answers = {
      "0_分析框架": "DMII分析法",
      "1_事件详情": "特朗普访问中东",
    };
    const handler = vi.fn().mockResolvedValue(answers);
    router.setAskUserHandler(handler);

    const req = makeReq("ask_user", { questions });
    const parts = await router.route(
      [req],
      new AbortController().signal,
      vi.fn(),
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(questions);
    // The tool response must include the answers text so LLM can continue
    const resp = parts[0]?.functionResponse?.response as any;
    const responseText = resp?.result ?? resp?.content ?? "";
    expect(responseText).toContain("DMII分析法");
    expect(responseText).toContain("特朗普访问中东");
  });

  it("ask_user: falls back to auto-select when no handler registered", async () => {
    const { router } = makeRouter();
    const questions = [
      {
        question: "选择方案",
        header: "方案",
        options: [
          { label: "A", description: "Recommended default" },
          { label: "B", description: "Alternative" },
        ],
      },
    ];

    const req = makeReq("ask_user", { questions });
    const parts = await router.route(
      [req],
      new AbortController().signal,
      vi.fn(),
    );

    const resp2 = parts[0]?.functionResponse?.response as any;
    const responseText = resp2?.result ?? resp2?.content ?? "";
    expect(responseText).toContain("AUTO-SELECTED");
  });

  it("ask_user: returns cancelled response when handler rejects", async () => {
    const { router } = makeRouter();
    const handler = vi.fn().mockRejectedValue(new Error("timeout"));
    router.setAskUserHandler(handler);

    const req = makeReq("ask_user", {
      questions: [{ question: "Q?", header: "Q" }],
    });
    const parts = await router.route(
      [req],
      new AbortController().signal,
      vi.fn(),
    );

    const resp3 = parts[0]?.functionResponse?.response as any;
    const responseText = resp3?.result ?? resp3?.content ?? "";
    expect(responseText).toContain("cancelled");
  });

  it("ask_user: setAskUserHandler(null) reverts to auto-select fallback", async () => {
    const { router } = makeRouter();
    const questions = [
      {
        question: "Q?",
        header: "Q",
        options: [{ label: "A", description: "Recommended default" }],
      },
    ];

    const handler = vi.fn().mockResolvedValue({});
    router.setAskUserHandler(handler);
    router.setAskUserHandler(null);

    const req = makeReq("ask_user", { questions });
    const parts = await router.route(
      [req],
      new AbortController().signal,
      vi.fn(),
    );

    expect(handler).not.toHaveBeenCalled();
    const resp = parts[0]?.functionResponse?.response as any;
    const responseText = resp?.result ?? resp?.content ?? "";
    expect(responseText).toContain("AUTO-SELECTED");
  });
});
