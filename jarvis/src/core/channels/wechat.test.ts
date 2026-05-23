/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock("undici", () => ({
  fetch: fetchMock,
  Agent: class Agent {},
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

vi.mock("qrcode-terminal", () => ({
  default: {
    generate: vi.fn(),
  },
}));

vi.mock("../../../../gemini-cli/packages/core/src/index.js", () => ({
  debugLogger: { debug: vi.fn() },
}));

import { ConfigManager } from "../configManager.js";
import { WechatChannel } from "./wechat.js";

describe("WechatChannel", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.spyOn(ConfigManager, "getInstance").mockReturnValue({
      get: () => ({
        wechat: {
          apiBaseUrl: "https://wechat.example.com",
        },
      }),
    } as any);
  });

  it("sendProactive succeeds when HTTP is ok and ret is 0", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ ret: 0 }),
    });

    const channel = new WechatChannel({} as any);
    (channel as any).session = {
      botToken: "token",
      baseUrl: "https://wechat.example.com",
      syncBuf: "",
      botId: "bot-1",
      userId: "user-1",
    };

    await expect(
      channel.sendProactive("user-1", "Hello from Jarvis"),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses the latest inbound user as the default push target", () => {
    const channel = new WechatChannel({} as any);
    (channel as any).session = {
      botToken: "token",
      baseUrl: "https://wechat.example.com",
      syncBuf: "",
      botId: "bot-1",
      userId: "login-user",
      lastInboundUserId: "recent-chat-user",
    };

    expect(channel.getDefaultUserId()).toBe("recent-chat-user");
  });

  it("sendProactive includes context_token for the latest inbound user", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ ret: 0 }),
    });

    const channel = new WechatChannel({} as any);
    (channel as any).session = {
      botToken: "token",
      baseUrl: "https://wechat.example.com",
      syncBuf: "",
      botId: "bot-1",
      userId: "login-user",
      lastInboundUserId: "recent-chat-user",
      lastInboundContextToken: "ctx-123",
    };

    await channel.sendProactive("recent-chat-user", "Hello");

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.msg.to_user_id).toBe("recent-chat-user");
    expect(body.msg.context_token).toBe("ctx-123");
  });

  it("sendProactive reports raw payload when ret is non-zero without message", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ ret: -2, extra: "opaque" }),
    });

    const channel = new WechatChannel({} as any);
    (channel as any).session = {
      botToken: "token",
      baseUrl: "https://wechat.example.com",
      syncBuf: "",
      botId: "bot-1",
      userId: "user-1",
    };

    await expect(channel.sendProactive("user-1", "Hello")).rejects.toThrow(
      /"extra":"opaque"/,
    );
  });

  it("sendProactive throws when HTTP is ok but ret is non-zero", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ ret: 1001, msg: "invalid user" }),
    });

    const channel = new WechatChannel({} as any);
    (channel as any).session = {
      botToken: "token",
      baseUrl: "https://wechat.example.com",
      syncBuf: "",
      botId: "bot-1",
      userId: "user-1",
    };

    await expect(channel.sendProactive("user-1", "Hello")).rejects.toThrow(
      /ret=1001/i,
    );
  });

  it("sendProactive throws when HTTP status is not ok", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: vi.fn(),
    });

    const channel = new WechatChannel({} as any);
    (channel as any).session = {
      botToken: "token",
      baseUrl: "https://wechat.example.com",
      syncBuf: "",
      botId: "bot-1",
      userId: "user-1",
    };

    await expect(channel.sendProactive("user-1", "Hello")).rejects.toThrow(
      /http 500/i,
    );
  });
});
