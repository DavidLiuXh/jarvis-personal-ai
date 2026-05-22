/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { DefaultMemoryRuntime } from "./runtime.js";
import type {
  ClarificationQuestion,
  MemoryContract,
  MemoryRuntime,
} from "./index.js";

describe("memory-runtime contracts", () => {
  it("defines a stable MemoryContract shape", () => {
    const contract: MemoryContract = {
      needMemory: true,
      subjectBoundary: "personal",
      targetScopes: ["session", "fact", "entry"],
      memoryTarget: "conversation_history",
      query: {
        raw: "帮我汇总之前梓潼相关的探讨内容",
        entities: ["梓潼"],
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
      reasons: ["personal_recall"],
      policyTrace: [],
    };

    expect(contract.targetScopes).toEqual(["session", "fact", "entry"]);
    expect(contract.constraints.allowPersonalFacts).toBe(true);
  });

  it("keeps clarification questions compatible with ask_user", () => {
    const question: ClarificationQuestion = {
      header: "Schedule",
      question: "这个提醒安排在什么时候？",
      type: "text",
      placeholder: "例如：明天早上 9 点",
    };
    const askUserQuestion: ClarificationQuestion = question;

    expect(askUserQuestion.type).toBe("text");
  });

  it("allows agent runtimes to implement the MemoryRuntime interface", async () => {
    const runtime: MemoryRuntime<{ subject: "personal" }> = {
      async understand() {
        return { subject: "personal" };
      },
      async planMemory() {
        return {
          needMemory: false,
          subjectBoundary: "external",
          targetScopes: [],
          memoryTarget: "none",
          query: { raw: "", entities: [] },
          confidence: { subject: 1, target: 1, query: 1 },
          constraints: {
            allowPersonalFacts: false,
            allowSessionHistory: false,
            allowEntries: false,
            maxChars: 0,
          },
          reasons: ["no_memory_needed"],
          policyTrace: [],
        };
      },
      async retrieve(contract) {
        return {
          contract,
          session: [],
          facts: [],
          entries: [],
        };
      },
      async inject() {
        return {
          text: "",
          usedChars: 0,
          injected: { session: 0, facts: 0, entries: 0 },
          rejected: [],
          trace: [],
        };
      },
      async observe() {},
    };

    await expect(
      runtime.understand({
        sessionId: "s1",
        prompt: "hello",
        history: [],
      }),
    ).resolves.toEqual({ subject: "personal" });
  });

  it("provides a default executable runtime implementation", async () => {
    const events: string[] = [];
    const contract: MemoryContract = {
      needMemory: true,
      subjectBoundary: "personal",
      targetScopes: ["entry"],
      memoryTarget: "conversation_history",
      query: { raw: "recall TypeScript", entities: ["TypeScript"] },
      confidence: { subject: 0.9, target: 0.9, query: 0.9 },
      constraints: {
        allowPersonalFacts: false,
        allowSessionHistory: false,
        allowEntries: true,
        maxChars: 500,
      },
      reasons: ["test"],
      policyTrace: [],
    };
    const runtime = new DefaultMemoryRuntime<{ subject: "personal" }>({
      async understand() {
        return { subject: "personal" };
      },
      async planMemory() {
        return contract;
      },
      async retrieve(inputContract) {
        return { contract: inputContract, session: [], facts: [], entries: [] };
      },
      async inject() {
        return {
          text: "<memory />",
          usedChars: 10,
          injected: { session: 0, facts: 0, entries: 0 },
          rejected: [],
          trace: [],
        };
      },
      observe(event) {
        events.push(event.type);
      },
    });

    const input = { sessionId: "s1", prompt: "hello", history: [] };
    const intent = await runtime.understand(input);
    const planned = await runtime.planMemory({
      prompt: input.prompt,
      history: input.history,
      intent,
    });
    const retrieval = await runtime.retrieve(planned);
    const injected = await runtime.inject({
      prompt: input.prompt,
      intent,
      contract: planned,
      retrieval,
      budget: { maxChars: 500 },
    });

    expect(injected.text).toBe("<memory />");
    expect(events).toEqual([
      "intent_resolved",
      "memory_retrieved",
      "memory_injected",
    ]);
  });
});
