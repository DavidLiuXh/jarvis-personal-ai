/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from "vitest";

// Mock all external dependencies
vi.mock("../../../core/src/index.js", () => ({
  GeminiClient: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    config: {
      storage: { getProjectTempDir: () => "/tmp/jarvis-test" },
      getToolRegistry: vi.fn().mockReturnValue({
        addDiscoveredTool: vi.fn(),
        getTool: vi.fn().mockReturnValue(null),
      }),
      getMessageBus: vi.fn().mockReturnValue({ subscribe: vi.fn() }),
      getUserMemory: vi.fn().mockReturnValue(""),
      refreshAuth: vi.fn().mockResolvedValue(undefined),
      initialize: vi.fn().mockResolvedValue(undefined),
    },
    getChat: vi.fn().mockReturnValue({
      getHistory: vi.fn().mockReturnValue([]),
    }),
    resumeChat: vi.fn().mockResolvedValue(undefined),
  })),
  Scheduler: vi.fn().mockImplementation(() => ({})),
  debugLogger: { debug: vi.fn(), error: vi.fn() },
  AuthType: { LOGIN_WITH_GOOGLE: "LOGIN_WITH_GOOGLE" },
  ApprovalMode: { NEVER: "NEVER" },
  ROOT_SCHEDULER_ID: "root",
}));

vi.mock("../../../gemini-cli/packages/core/src/index.js", () => ({
  GeminiClient: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    config: {
      storage: { getProjectTempDir: () => "/tmp/jarvis-test" },
      getToolRegistry: vi.fn().mockReturnValue({
        addDiscoveredTool: vi.fn(),
        getTool: vi.fn().mockReturnValue(null),
      }),
      getMessageBus: vi.fn().mockReturnValue({ subscribe: vi.fn() }),
      getUserMemory: vi.fn().mockReturnValue(""),
      refreshAuth: vi.fn().mockResolvedValue(undefined),
      initialize: vi.fn().mockResolvedValue(undefined),
    },
    getChat: vi.fn().mockReturnValue({
      getHistory: vi.fn().mockReturnValue([]),
    }),
    resumeChat: vi.fn().mockResolvedValue(undefined),
  })),
  Scheduler: vi.fn().mockImplementation(() => ({})),
  debugLogger: { debug: vi.fn(), error: vi.fn() },
  AuthType: { LOGIN_WITH_GOOGLE: "LOGIN_WITH_GOOGLE" },
  ApprovalMode: { NEVER: "NEVER" },
  ROOT_SCHEDULER_ID: "root",
  LlmRole: { UTILITY_SUMMARIZER: "UTILITY_SUMMARIZER" },
}));

vi.mock("../../../cli/src/config/config.js", () => ({
  loadCliConfig: vi.fn().mockResolvedValue({
    storage: {
      targetDir: "/tmp",
      getProjectTempDir: () => "/tmp/jarvis-test",
    },
    getToolRegistry: vi.fn().mockReturnValue({
      addDiscoveredTool: vi.fn(),
      getTool: vi.fn().mockReturnValue(null),
    }),
    getMessageBus: vi.fn().mockReturnValue({ subscribe: vi.fn() }),
    getUserMemory: vi.fn().mockReturnValue(""),
    refreshAuth: vi.fn().mockResolvedValue(undefined),
    initialize: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../../../gemini-cli/packages/cli/src/config/config.js", () => ({
  loadCliConfig: vi.fn().mockResolvedValue({
    storage: {
      targetDir: "/tmp",
      getProjectTempDir: () => "/tmp/jarvis-test",
    },
    getToolRegistry: vi.fn().mockReturnValue({
      addDiscoveredTool: vi.fn(),
      getTool: vi.fn().mockReturnValue(null),
    }),
    getMessageBus: vi.fn().mockReturnValue({ subscribe: vi.fn() }),
    getUserMemory: vi.fn().mockReturnValue(""),
    refreshAuth: vi.fn().mockResolvedValue(undefined),
    initialize: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../../../cli/src/config/settings.js", () => ({
  loadSettings: vi.fn().mockReturnValue({
    merged: {
      general: {},
      tools: {},
      context: {},
      model: {},
      security: { auth: { selectedType: "LOGIN_WITH_GOOGLE" } },
    },
  }),
}));

vi.mock("../../../gemini-cli/packages/cli/src/config/settings.js", () => ({
  loadSettings: vi.fn().mockReturnValue({
    merged: {
      general: {},
      tools: {},
      context: {},
      model: {},
      security: { auth: { selectedType: "LOGIN_WITH_GOOGLE" } },
    },
  }),
}));

vi.mock("../../../core/src/services/chatRecordingService.js", () => ({
  SESSION_FILE_PREFIX: "session-",
}));

vi.mock("./configManager.js", () => ({
  ConfigManager: {
    getInstance: vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue({
        api: { key: "", proxy: "" },
        models: {
          chat: "auto",
          embedding: "text-embedding-004",
          distillation: "gemini-2.5-flash",
        },
        session: { resumeOnStart: false },
      }),
    }),
  },
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  realpathSync: vi.fn((value: string) => value),
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    realpathSync: vi.fn((value: string) => value),
  },
}));

import { AgentInitializer } from "./geminiAgentInitializer.js";

describe("AgentInitializer", () => {
  it("returns a client and scheduler after initialize()", async () => {
    const memoryService = {
      setConfig: vi.fn(),
      saveFact: vi.fn(),
      search: vi.fn(),
    };
    const dynamicRegistry = {
      getDynamicToolSchemas: vi.fn().mockReturnValue([]),
    };

    const initializer = new AgentInitializer(
      "session-123",
      "/tmp/test-cwd",
      memoryService as any,
      dynamicRegistry as any,
    );

    const result = await initializer.initialize(vi.fn());

    expect(result.client).toBeDefined();
    expect(result.scheduler).toBeDefined();
    expect(memoryService.setConfig).toHaveBeenCalledOnce();
  });
});
