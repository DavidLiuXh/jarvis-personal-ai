import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CompositeSessionStore,
  DefaultLayeredMemoryRuntime,
  DefaultMemoryRuntime,
  DefaultMemoryStore,
  DefaultMemoryWriterRuntime,
  GeminiCliSessionStore,
  JarvisJsonlSessionStore,
  MemoryInjectionPlanner,
  buildRecentConversationRecallCandidates,
  buildIntentAwareMemoryPolicy,
  extractConversationRecallTerms,
  extractSessionSearchTerms,
  scoreSessionSearchCandidates,
  type IntentFrame,
  type MemoryContract,
  type SessionStore,
} from "./index.js";

describe("@jarvis/memory-runtime package API", () => {
  it("exports the minimal runtime lifecycle and policy helpers", async () => {
    const contract: MemoryContract = {
      needMemory: false,
      subjectBoundary: "mixed",
      memoryTarget: "none",
      targetScopes: [],
      query: { raw: "hello", entities: [] },
      confidence: { subject: 1, target: 1, query: 1 },
      constraints: {
        allowPersonalFacts: false,
        allowSessionHistory: false,
        allowEntries: false,
        maxChars: 0,
      },
      reasons: ["test"],
      policyTrace: [],
    };
    const runtime = new DefaultMemoryRuntime({
      async understand(turn) {
        return { query: turn.prompt, subject: "mixed" };
      },
      async planMemory() {
        return contract;
      },
      async retrieve(contract) {
        return { contract, session: [], facts: [], entries: [] };
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
    });

    const turn = {
      sessionId: "test",
      prompt: "hello",
      history: [],
      timestamp: "2026-05-31T00:00:00.000Z",
    };
    const intent = await runtime.understand(turn);
    const planned = await runtime.planMemory({
      prompt: turn.prompt,
      history: turn.history,
      intent,
    });
    const retrieval = await runtime.retrieve(planned);
    const result = await runtime.inject({
      prompt: turn.prompt,
      intent,
      contract: planned,
      retrieval,
      budget: { maxChars: 100 },
    });

    expect(result.usedChars).toBe(0);
    expect(
      new MemoryInjectionPlanner().buildPlan({
        querySubject: "personal",
        factCandidates: [
          {
            category: "interaction_style",
            content: "user likes concise replies",
          },
        ],
        summaryCandidates: [],
        prewarmCandidates: [],
      }).facts,
    ).toHaveLength(1);
    expect(
      buildIntentAwareMemoryPolicy({
        userPrompt: "hello",
        querySubject: "external",
        intent: null,
        config: {},
      }).allowFacts,
    ).toBe(false);
  });

  it("exports writer, governance, and default store APIs", async () => {
    const store = new DefaultMemoryStore();
    const writer = new DefaultMemoryWriterRuntime({ store });
    const [result] = await writer.write([
      {
        operation: "upsert",
        item: {
          id: "fact-1",
          scope: "fact",
          subject: "preference",
          content: "The user prefers concise Chinese replies.",
          confidence: 0.95,
          sourceRefs: ["test"],
          createdAt: "2026-06-02T00:00:00.000Z",
          updatedAt: "2026-06-02T00:00:00.000Z",
        },
      },
    ]);

    expect(result.decision.action).toBe("insert");
    expect(await store.listFacts()).toHaveLength(1);
  });

  it("exports the layered memory runtime facade", async () => {
    const store = new DefaultMemoryStore();
    const runtime = new DefaultLayeredMemoryRuntime({
      stores: { facts: store, entries: store, session: store },
      writeStore: store,
    });

    const result = await runtime.saveEntry({
      id: "entry-api",
      scope: "entry",
      kind: "event",
      content: "Layered memory runtime exported from package API.",
      entities: ["memory"],
      timestamp: "2026-06-02T00:00:00.000Z",
      sourceRefs: ["test"],
    });

    expect(result.written?.id).toBe("entry-api");
    expect(
      await runtime.searchEntries({ query: "Layered memory" }),
    ).toHaveLength(1);
  });

  it("exports session transcript store contracts and search helpers", () => {
    const store: SessionStore = {
      capabilities: { read: true, write: false, search: true },
      async listSessions() {
        return [];
      },
      async readSession() {
        return null;
      },
      async searchTurns() {
        return [];
      },
    };
    const terms = extractSessionSearchTerms("帮我汇总之前梓潼相关的探讨内容");
    const results = scoreSessionSearchCandidates({
      query: "梓潼",
      candidates: [
        {
          sessionId: "s1",
          text: "User: 梓潼的文化意义是什么？",
          timestamp: 1,
        },
      ],
    });

    expect(store.capabilities.search).toBe(true);
    expect(terms).toContain("梓潼");
    expect(results[0].sessionId).toBe("s1");
  });

  it("exports writable JSONL and composite session stores", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-runtime-api-"));
    const jsonl = new JarvisJsonlSessionStore({ dir });
    const composite = new CompositeSessionStore([jsonl]);

    await composite.appendTurn({
      sessionId: "api-session",
      turn: {
        role: "user",
        content: "hello",
        metadata: { backend: "openai" },
      },
    });

    const session = await composite.readSession("api-session");
    expect(session?.turns[0].metadata?.backend).toBe("openai");
  });

  it("exports legacy Gemini session adapter and recent recall helpers", async () => {
    const chatsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "memory-runtime-gemini-api-"),
    );
    fs.writeFileSync(
      path.join(chatsDir, "session-2026-06-02-api.jsonl"),
      [
        JSON.stringify({
          id: "u1",
          timestamp: "2026-06-02T10:00:00.000Z",
          type: "user",
          content: "梓潼相关讨论是什么？",
        }),
        JSON.stringify({
          id: "a1",
          timestamp: "2026-06-02T10:01:00.000Z",
          type: "gemini",
          content: "梓潼与文昌帝君、古蜀道有关。",
        }),
      ].join("\n") + "\n",
    );
    const geminiStore = new GeminiCliSessionStore({ chatsDir });
    const transcriptResults = await geminiStore.searchTurns({ query: "梓潼" });
    const intent = {
      semanticEvidence: {
        memoryRecall: { target: "conversation_history" },
        entityHints: { technicalTerms: [], peopleOrCompanies: [] },
      },
      richIntent: { targets: [{ value: "梓潼相关讨论" }] },
      topicAnalysis: {
        history: { label: "", evidence: [] },
        current: { label: "", evidence: [] },
      },
    } as IntentFrame;

    expect(transcriptResults[0].text).toContain("文昌帝君");
    expect(
      extractConversationRecallTerms("帮我汇总之前梓潼相关的探讨内容", intent),
    ).toContain("梓潼");
    expect(
      buildRecentConversationRecallCandidates({
        userPrompt: "帮我汇总之前梓潼相关的探讨内容",
        intent,
        conversationHistory: [
          { role: "user", content: "我们聊过梓潼。" },
          { role: "assistant", content: "梓潼和文昌帝君有关。" },
        ],
      })[0].text,
    ).toContain("文昌帝君");
  });
});
