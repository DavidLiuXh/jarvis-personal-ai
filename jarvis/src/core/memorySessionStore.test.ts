import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  SessionAppendInput,
  SessionStore,
} from "../memory-runtime/index.js";

describe("MemoryService session store integration", () => {
  it("appends transcript turns through the injected SessionStore", async () => {
    const { MemoryService } = await import("./memory.js");
    const appendTurn = vi.fn<(input: SessionAppendInput) => Promise<void>>();
    const store: SessionStore = {
      capabilities: { read: true, write: true, search: true },
      async listSessions() {
        return [];
      },
      async readSession() {
        return null;
      },
      async searchTurns() {
        return [];
      },
      appendTurn,
    };
    const service = new MemoryService(
      "",
      fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-memory-db-")),
      store,
    );

    await service.appendSessionTurn({
      sessionId: "s1",
      role: "assistant",
      content: "done",
      metadata: { backend: "openai", model: "gpt-4.1" },
    });

    expect(appendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s1",
        turn: expect.objectContaining({
          role: "assistant",
          content: "done",
          metadata: { backend: "openai", model: "gpt-4.1" },
        }),
      }),
    );
  });
});
