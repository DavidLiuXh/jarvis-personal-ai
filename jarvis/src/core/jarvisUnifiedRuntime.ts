/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentRuntime,
  type RuntimeSkill,
  type ToolLoopRuntimeOptions,
  type ToolLoopRunResult,
} from "../agent-runtime/index.js";
import {
  DefaultIntentRuntime,
  IntentExecutor,
  StaticIntentResolverAdapter,
  type AutonomousTaskRuntimeResult,
  type TaskGraph,
  type TaskRuntimeArtifact,
} from "../intent-runtime/index.js";
import {
  DefaultMemoryRuntime,
  DefaultLayeredMemoryRuntime,
  DefaultMemoryRetriever,
  type EntryMemorySearchResult,
  type MemoryContract,
  type MemoryInjectionResult,
  type MemoryRetrievalResult,
  type SkillRetrievalExtension,
  type StepMemoryDecision,
} from "../memory-runtime/index.js";
import type { JarvisConfig } from "./configManager.js";
import { buildRecentConversationRecallCandidates } from "./conversationRecall.js";
import {
  buildIntentAwareMemoryPolicy,
  buildStepMemoryDecisions,
} from "./intentAwareMemoryPolicy.js";
import type { IntentFrame } from "./intentResolver.js";
import { buildIntentPlanSection } from "./intentPlan.js";
import { createJarvisRuntimeMemoryLayer } from "./jarvisRuntimeMemoryLayer.js";
import { createJarvisTaskRuntime } from "./jarvisTaskGraphRuntime.js";
import type { LocalModelRouter } from "./localModelRouter.js";
import type { MemoryService } from "./memory.js";
import {
  MemoryInjectionPlanner,
  type PrewarmCandidate,
  type SummaryCandidate,
} from "./memoryInjectionPlanner.js";
import type { RuntimeIntentFeedbackCollector } from "./runtimeIntentFeedbackCollector.js";
import {
  buildJarvisPreamble,
  type FactRecord,
  type SkillInfo,
  type SystemPromptBuilder,
} from "./systemPromptBuilder.js";
import { buildRelevantSummarySectionFallback } from "./sessionSummarizer.js";
import type { ToolRouter } from "./toolRouter.js";

export type JarvisUnifiedRuntimeTurnInput = {
  sessionId: string;
  userPrompt: string;
  querySubject: "personal" | "external" | "mixed";
  timeWindowDays: number | null;
  resolvedDateRange: { from: number; to: number } | null;
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
  intent: IntentFrame | null;
  llmRuntime?: {
    options: ToolLoopRuntimeOptions;
    initialMessages: Parameters<
      AgentRuntime["handleTurn"]
    >[0]["llmInitialMessages"];
    signal: AbortSignal;
  };
  currentContent?: string;
  artifacts?: Record<string, string>;
  jarvisConfig: JarvisConfig;
  memoryService: MemoryService;
  availableSkills: SkillInfo[];
  conversationSummary: string;
  localModelRouter: LocalModelRouter | null;
  promptBuilder: SystemPromptBuilder;
  toolRouter: ToolRouter;
  runtimeIntentFeedbackCollector: RuntimeIntentFeedbackCollector;
  interactiveChannel: boolean;
  buildMemoryInjectionPlanner: () => MemoryInjectionPlanner;
};

export type JarvisUnifiedRuntimeTurnResult = {
  memoryContract: MemoryContract;
  stepMemoryDecisions: StepMemoryDecision[];
  llmLoop: ToolLoopRunResult | null;
  systemInstruction: string;
  taskGraph: TaskGraph | null;
  taskGraphExecution: AutonomousTaskRuntimeResult | null;
};

function buildFallbackRuntimeIntent(args: {
  userPrompt: string;
  querySubject: "personal" | "external" | "mixed";
  timeWindowDays: number | null;
  resolvedDateRange: { from: number; to: number } | null;
}): IntentFrame {
  return {
    subject: args.querySubject,
    taskType: "chat",
    needsMemory: args.querySubject !== "external",
    needsExternalKnowledge: args.querySubject !== "personal",
    needsTool: false,
    needsScheduling: false,
    candidateAgents: [],
    timeWindowDays: args.timeWindowDays,
    dateFrom: null,
    dateTo: null,
    resolvedDateRange: args.resolvedDateRange,
    topicShifted: false,
    referencesRecentHistory: false,
    complexityScore: 50,
    knowledgeScore: args.querySubject === "personal" ? 20 : 60,
    operationScore: 0,
    reason: "Fallback intent used when local intent routing is unavailable.",
    confidence: 0.5,
    confidenceByDimension: {
      subject: 0.5,
      taskType: 0.5,
      memoryTarget: 0.2,
      action: 0.2,
      entityHints: 0,
      topicShift: 0,
      richIntent: 0.3,
    },
    evidence: [args.userPrompt],
    semanticEvidence: {
      personalContext: {
        present: args.querySubject !== "external",
        reason: "fallback_subject_boundary",
        span: "",
      },
      memoryRecall: { present: false, target: "none", reason: "", span: "" },
      actionRequest: { present: false, action: "none", object: "" },
      entityHints: { tickers: [], technicalTerms: [], peopleOrCompanies: [] },
    },
    richIntent: {
      userGoal: args.userPrompt,
      domain: "general_chat",
      action: "answer",
      primaryAction: "answer",
      targets: [],
      contextDependency: {
        recentConversation: false,
        longTermMemory: args.querySubject !== "external",
        externalWorld: args.querySubject !== "personal",
        localWorkspace: false,
      },
      ambiguity: [],
      riskLevel: "low",
    },
    intentSteps: [],
    topicAnalysis: {
      relation: "unknown",
      history: { label: "", evidence: [], sourceTurns: [], confidence: 0 },
      current: {
        label: "Fallback Chat",
        evidence: [args.userPrompt],
        sourceTurns: [0],
        confidence: 0.5,
      },
      relationReason: "fallback_intent",
      confidence: 0.5,
      lowGrounding: true,
    },
    policyTrace: [
      {
        ruleId: "fallback.runtime_intent",
        stage: "finalize",
        priority: 0,
        reasonCode: "FALLBACK_RUNTIME_INTENT",
        reason: {
          code: "FALLBACK_RUNTIME_INTENT",
          category: "task_boundary",
          severity: "warning",
        },
        applied: true,
        before: { intent: null },
        after: { subject: args.querySubject, taskType: "chat" },
      },
    ],
    source: "jarvis-runtime-fallback",
  };
}

function formatLocalDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function buildTemporalRecallBoundary(contract: MemoryContract | null): string {
  if (
    !contract ||
    contract.memoryTarget !== "conversation_history" ||
    !contract.query.timeRange
  ) {
    return "";
  }
  const from = formatLocalDate(contract.query.timeRange.from);
  const to = formatLocalDate(contract.query.timeRange.to - 1);
  return [
    "<temporal_recall_boundary>",
    `requested_time_range: ${from}~${to}`,
    "Use only retrieved conversation entries/session summaries that fall inside this requested time range.",
    "Do not answer from the current/recent chat history when it falls outside this time range.",
    "If the injected memory context does not contain matching entries for this range, say that no matching conversation history was found for the requested period.",
    "</temporal_recall_boundary>",
  ].join("\n");
}

function compactRuntimeArtifactContent(content: string, max = 6000): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}...`;
}

function stringifyRuntimeArtifactItem(item: unknown): string {
  if (typeof item === "string") return item;
  if (item === null || item === undefined) return "";
  try {
    return JSON.stringify(item);
  } catch {
    return String(item);
  }
}

function normalizePromptText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function shouldInjectRuntimeArtifactItem(
  item: string,
  userPrompt?: string,
): boolean {
  const text = item.trim();
  if (!text) return false;
  if (
    userPrompt &&
    normalizePromptText(text) === `user: ${normalizePromptText(userPrompt)}`
  ) {
    return false;
  }
  return true;
}

function formatRuntimeArtifactMemoryItems(
  items: unknown[] | undefined,
  userPrompt?: string,
): string {
  const filtered =
    items
      ?.map(stringifyRuntimeArtifactItem)
      .filter((item) => shouldInjectRuntimeArtifactItem(item, userPrompt)) ??
    [];
  if (filtered.length === 0) return "";
  return [
    "<retrieved_memory>",
    ...filtered
      .slice(0, 12)
      .map((item) => `- ${compactRuntimeArtifactContent(item, 800)}`),
    "</retrieved_memory>",
  ].join("\n");
}

function buildTaskGraphArtifactSection(
  execution: AutonomousTaskRuntimeResult | null,
  userPrompt?: string,
): string {
  const artifacts = execution?.execution.artifacts ?? [];
  if (artifacts.length === 0) return "";
  const sections = artifacts
    .map((artifact) => {
      if (artifact.type === "memory") {
        return formatRuntimeArtifactMemoryItems(
          artifact.memoryItems,
          userPrompt,
        );
      }
      if (artifact.type === "file") {
        return [
          "<task_artifact>",
          "type: file",
          artifact.path ? `path: ${artifact.path}` : "",
          artifact.exists !== undefined ? `exists: ${artifact.exists}` : "",
          artifact.content
            ? `content: ${compactRuntimeArtifactContent(artifact.content, 1200)}`
            : "",
          "</task_artifact>",
        ]
          .filter(Boolean)
          .join("\n");
      }
      if (artifact.type === "scheduled_task") {
        return [
          "<task_artifact>",
          "type: scheduled_task",
          artifact.taskId ? `task_id: ${artifact.taskId}` : "",
          artifact.content
            ? `content: ${compactRuntimeArtifactContent(artifact.content, 800)}`
            : "",
          "</task_artifact>",
        ]
          .filter(Boolean)
          .join("\n");
      }
      return artifact.content
        ? [
            "<task_artifact>",
            `type: ${artifact.type}`,
            `content: ${compactRuntimeArtifactContent(artifact.content, 800)}`,
            "</task_artifact>",
          ].join("\n")
        : "";
    })
    .filter(Boolean);
  return sections.join("\n\n");
}

function shouldLogTaskGraphArtifactContent(config: JarvisConfig): boolean {
  return (
    config.memory?.writeObservability === true ||
    config.agentRuntime?.observability === true ||
    config.agentRuntime?.autonomousTaskRuntime?.observability === true
  );
}

function formatTaskGraphArtifactContentLog(
  artifacts: TaskRuntimeArtifact[],
): string {
  if (artifacts.length === 0) return "";
  return [
    "🧭 [TaskGraph] artifact content:",
    ...artifacts.map((artifact) =>
      [
        `  - ${artifact.id}:${artifact.type} node=${artifact.nodeId}` +
          (artifact.path ? ` path=${artifact.path}` : "") +
          (artifact.checksum ? ` checksum=${artifact.checksum}` : "") +
          (artifact.memoryItems
            ? ` memoryItems=${artifact.memoryItems.length}`
            : ""),
        artifact.type === "memory"
          ? formatRuntimeArtifactMemoryItems(artifact.memoryItems)
              .split("\n")
              .map((line) => `    ${line}`)
              .join("\n")
          : "",
        artifact.content
          ? `    ${artifact.type === "memory" ? "raw_content" : "content"}: ${compactRuntimeArtifactContent(
              artifact.content,
              2000,
            )}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  ].join("\n");
}

function hasCompletedTaskGraphMemoryRecall(
  execution: AutonomousTaskRuntimeResult | null,
): boolean {
  const result = execution?.execution;
  if (!result) return false;
  const succeededRecallNodeIds = new Set(
    result.nodes
      .filter(
        (state) => state.node.kind === "recall" && state.status === "succeeded",
      )
      .map((state) => state.node.id),
  );
  if (succeededRecallNodeIds.size === 0) return false;
  return result.artifacts.some(
    (artifact) =>
      artifact.type === "memory" && succeededRecallNodeIds.has(artifact.nodeId),
  );
}

function hasTaskGraphRecallNode(
  execution: AutonomousTaskRuntimeResult | null,
): boolean {
  return execution?.graph.nodes.some((node) => node.kind === "recall") === true;
}

function buildTaskGraphToolPolicySection(
  execution: AutonomousTaskRuntimeResult | null,
): string {
  if (!hasTaskGraphRecallNode(execution)) return "";
  const completed = hasCompletedTaskGraphMemoryRecall(execution);
  return [
    "<runtime_tool_policy>",
    "recall_memory: disabled_for_this_turn",
    `reason: ${completed ? "task_graph_memory_recall_completed" : "task_graph_owns_memory_recall"}`,
    completed
      ? "Use the retrieved_memory artifacts already provided. Do not request another memory recall unless the user asks for a new recall scope."
      : "Honor the TaskGraph execution contract. Do not request memory recall outside the planned recall step.",
    "</runtime_tool_policy>",
  ].join("\n");
}

function extractSummaryCandidatesFromSection(
  section: string,
): SummaryCandidate[] {
  if (!section.trim()) return [];
  return section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => ({
      text: line.replace(/^-\s+/, "").trim(),
      source: "fallback" as const,
    }))
    .filter((item) => item.text);
}

function summaryCandidatesFromRetrieval(
  retrieval: MemoryRetrievalResult,
): SummaryCandidate[] {
  return retrieval.session
    .map(({ item, reason }) => ({
      text: item.summary ?? "",
      source: reason?.startsWith("summary_fallback_")
        ? ("fallback" as const)
        : ("vector" as const),
    }))
    .filter((item) => item.text.trim());
}

function factRecordsFromRetrieval(
  retrieval: MemoryRetrievalResult,
): FactRecord[] {
  return retrieval.facts.map(({ item }) => ({
    category:
      typeof item.metadata?.category === "string"
        ? item.metadata.category
        : item.subject,
    content: item.content,
  }));
}

function prewarmCandidatesFromRetrieval(args: {
  retrieval: MemoryRetrievalResult;
  rerankerEnabled: boolean;
  rerankerThreshold: number;
}): PrewarmCandidate[] {
  const recent = args.retrieval.entries
    .filter(({ item }) => item.metadata?.source === "recent_conversation")
    .map(({ item, score }) => ({
      text: item.content,
      score,
      tier: "verified" as const,
    }));
  const memories = args.retrieval.entries.filter(
    ({ item }) => item.metadata?.source !== "recent_conversation",
  );
  if (memories.length === 0) return recent;

  const MIN_TOP1_SCORE = 0.5;
  const MIN_MARGIN = 0.1;
  let toInject = memories;
  if (!args.rerankerEnabled && memories.length > 0) {
    if (memories[0].score < MIN_TOP1_SCORE) {
      console.error(
        `🧠 [prewarm] top-1 score ${memories[0].score.toFixed(3)} < ${MIN_TOP1_SCORE}, skipping injection`,
      );
      toInject = [];
    } else if (
      memories.length > 1 &&
      memories[0].score - memories[1].score < MIN_MARGIN
    ) {
      toInject = memories.slice(0, 1);
      console.error(
        `🧠 [prewarm] low margin (${(memories[0].score - memories[1].score).toFixed(3)}), capping to top-1`,
      );
    }
  }

  const VERIFIED_THRESHOLD = 0.7;
  const verified = args.rerankerEnabled
    ? toInject.filter((m) => m.score >= args.rerankerThreshold)
    : toInject.filter((m) => m.score >= VERIFIED_THRESHOLD);
  const uncertain = args.rerankerEnabled
    ? []
    : toInject.filter((m) => m.score < VERIFIED_THRESHOLD);

  return [
    ...recent,
    ...verified.map(({ item, score }) => ({
      text: item.content,
      score,
      tier: "verified" as const,
    })),
    ...uncertain.map(({ item, score }) => ({
      text: item.content,
      score,
      tier: "uncertain" as const,
    })),
  ];
}

export async function runJarvisUnifiedRuntimeTurn(
  input: JarvisUnifiedRuntimeTurnInput,
): Promise<JarvisUnifiedRuntimeTurnResult> {
  let memoryPolicy: ReturnType<typeof buildIntentAwareMemoryPolicy> | null =
    null;
  let injectionPlan: ReturnType<MemoryInjectionPlanner["buildPlan"]> | null =
    null;
  let runtimeSystemContext = "";
  let retrievalCandidateCounts = { facts: 0, summary: 0, prewarm: 0 };
  let querySubject = input.querySubject;
  const runtimeIntent =
    input.intent ??
    buildFallbackRuntimeIntent({
      userPrompt: input.userPrompt,
      querySubject,
      timeWindowDays: input.timeWindowDays,
      resolvedDateRange: input.resolvedDateRange,
    });

  const skillSearchLimit = input.jarvisConfig.memory.skillSearchLimit ?? 5;
  const skillMaxDistance = input.jarvisConfig.memory.skillMaxDistance ?? 0.9;
  const skillRetrievalExtension: SkillRetrievalExtension<SkillInfo> = {
    retrieveSkills: async ({ prompt, limit, maxDistance }) => {
      if (input.availableSkills.length <= limit) return input.availableSkills;
      if (input.memoryService.skillIndexBuilding) {
        console.error(
          `🔍 [SkillRetrieval] Index building — using full skill list (${input.availableSkills.length} skills)`,
        );
        return input.availableSkills;
      }
      const retrieved = await input.memoryService.searchSkills(
        prompt,
        limit,
        maxDistance,
      );
      if (retrieved.length > 0) {
        console.error(
          `🔍 [SkillRetrieval] ${retrieved.length}/${input.availableSkills.length} skills injected: ${retrieved.map((s) => s.name).join(", ")}`,
        );
        return retrieved;
      }
      console.error(
        "🔍 [SkillRetrieval] No relevant skills found — skipping skill injection",
      );
      return [];
    },
  };
  let relevantSkills: SkillInfo[] = [];
  const defaultInstruction = buildJarvisPreamble();
  const runtimeMemoryLayer = createJarvisRuntimeMemoryLayer({
    memoryService: input.memoryService,
    sessionId: input.sessionId,
    config: input.jarvisConfig,
    runtimeIntentFeedbackCollector: input.runtimeIntentFeedbackCollector,
  });
  const taskGraphExecutionEnabled =
    input.jarvisConfig.agentRuntime?.autonomousTaskRuntime?.enabled === true &&
    input.jarvisConfig.agentRuntime.autonomousTaskRuntime.mode === "execute";

  const memoryRuntime = new DefaultMemoryRuntime<IntentFrame | null>({
    understand: async () => runtimeIntent,
    planMemory: async ({ intent: plannedIntent }) => {
      memoryPolicy = buildIntentAwareMemoryPolicy({
        userPrompt: input.userPrompt,
        querySubject,
        intent: plannedIntent,
        config: {
          prewarmLimit: input.jarvisConfig.memory.prewarmLimit ?? 3,
          prewarmLimitMixed: input.jarvisConfig.memory.prewarmLimitMixed ?? 1,
          memoryMaxDistance: input.jarvisConfig.memory.memoryMaxDistance ?? 1.0,
          prewarmMaxDistanceMixed:
            input.jarvisConfig.memory.prewarmMaxDistanceMixed ?? 0.6,
        },
      });
      querySubject = memoryPolicy.querySubject;
      if (taskGraphExecutionEnabled && memoryPolicy.contract.needMemory) {
        console.error(
          `🧭 [Jarvis] TaskGraph memory mode — generic fact/prewarm retrieval deferred to planned memory step(s). target=${memoryPolicy.contract.memoryTarget}, scopes=${memoryPolicy.contract.targetScopes.join(",") || "none"}`,
        );
      } else if (!memoryPolicy.allowFacts) {
        console.error(
          `🔍 [Jarvis] Intent-aware memory policy — skipping facts (${memoryPolicy.reasons.join(",") || "not_needed"}).`,
        );
      } else {
        const hasPrefix = memoryPolicy.factQuery !== input.userPrompt;
        console.error(
          `🔍 [Jarvis] searchFacts (subject=${querySubject}, prefix=${hasPrefix}): "${memoryPolicy.factQuery.slice(0, 80)}"`,
        );
      }
      if (!memoryPolicy.allowPrewarm || memoryPolicy.prewarmLimit <= 0) {
        console.error(
          `🧠 [prewarm] disabled by intent-aware policy (${memoryPolicy.reasons.join(",") || "not_needed"})`,
        );
      }
      if (!memoryPolicy.allowSummary && input.conversationSummary.trim()) {
        console.error(
          `🧠 [summary] disabled by intent-aware policy (${memoryPolicy.reasons.join(",") || "not_needed"})`,
        );
      }
      return {
        ...memoryPolicy.contract,
        query: {
          ...memoryPolicy.contract.query,
          timeRange:
            input.resolvedDateRange ??
            memoryPolicy.contract.query.timeRange ??
            undefined,
        },
      };
    },
    retrieve: async (contract) => {
      if (!memoryPolicy) {
        throw new Error("Memory policy was not planned before retrieval");
      }
      const queryRewriteEnabled =
        input.jarvisConfig.routing?.queryRewrite === true;
      const retriever = new DefaultMemoryRetriever({
        stores: runtimeMemoryLayer.stores,
        factLimit: input.jarvisConfig.memory.factRelevanceLimit ?? 5,
        entryLimit: memoryPolicy.prewarmLimit,
        entryMaxDistance: memoryPolicy.prewarmMaxDistance,
        sessionLimit: 2,
        sessionMaxDistance: 0.72,
        context: {
          prompt: input.userPrompt,
          history: input.conversationHistory,
          intent: input.intent,
        },
        extensions: {
          planQuery: async ({ scope, defaultQuery }) => {
            if (!memoryPolicy) return defaultQuery;
            if (scope === "fact") return memoryPolicy.factQuery;
            if (scope === "session") return memoryPolicy.prewarmQuery;
            if (scope !== "entry") return defaultQuery;
            if (queryRewriteEnabled && !input.localModelRouter) {
              console.error(
                "⚠️ [prewarm] routing.queryRewrite=true but localModelRouter is not initialized — query rewrite skipped. Set routing.enabled=true and routing.model to enable.",
              );
              return memoryPolicy.prewarmQuery;
            }
            if (
              queryRewriteEnabled &&
              memoryPolicy.shouldRewritePrewarmQuery &&
              input.localModelRouter
            ) {
              const rewritten = await input.localModelRouter.rewriteMemoryQuery(
                memoryPolicy.prewarmQuery,
                input.conversationHistory,
              );
              if (rewritten) {
                console.error(
                  `🔍 [prewarm] query rewrite: "${input.userPrompt.slice(0, 80)}" → "${rewritten}"`,
                );
                return rewritten;
              }
            }
            return memoryPolicy.prewarmQuery;
          },
          augmentEntries: (): EntryMemorySearchResult[] => {
            const candidates = buildRecentConversationRecallCandidates({
              userPrompt: input.userPrompt,
              intent: input.intent,
              conversationHistory: input.conversationHistory,
              maxCandidates: 2,
            });
            if (candidates.length > 0) {
              console.error(
                `🧠 [conversation-recall] recent matches(${candidates.length}): ` +
                  candidates
                    .map((candidate) => candidate.matchedTerms.join(","))
                    .join(" | "),
              );
            } else if (
              input.intent?.semanticEvidence.memoryRecall.target ===
              "conversation_history"
            ) {
              console.error(
                `🧠 [conversation-recall] no recent chat history match for query="${memoryPolicy.prewarmQuery.slice(0, 80)}"`,
              );
            }
            return candidates.map((candidate, index) => ({
              id: `recent-conversation-${index}`,
              kind: "conversation" as const,
              content: candidate.text,
              score: 1,
              entities: candidate.matchedTerms,
              metadata: { source: "recent_conversation" },
            }));
          },
          fallbackSession: ({ query }) => {
            if (!input.conversationSummary.trim()) return [];
            const fallbackSection = buildRelevantSummarySectionFallback(
              input.conversationSummary,
              query,
            );
            return extractSummaryCandidatesFromSection(fallbackSection).map(
              (candidate, index) => ({
                sessionId: input.sessionId,
                summary: candidate.text,
                score: 1,
                reason: `summary_fallback_${index}`,
                metadata: { source: "fallback" },
              }),
            );
          },
        },
      });
      const layeredRuntime = new DefaultLayeredMemoryRuntime({
        stores: runtimeMemoryLayer.stores,
        writeStore: runtimeMemoryLayer.writeStore,
        sessionId: input.sessionId,
        retriever,
      });
      return layeredRuntime.recall(contract);
    },
    inject: async ({ retrieval }) => {
      if (!memoryPolicy) {
        throw new Error("Memory policy was not planned before injection");
      }
      const facts = factRecordsFromRetrieval(retrieval);
      const summaryCandidates = summaryCandidatesFromRetrieval(retrieval);
      const prewarmCandidates = prewarmCandidatesFromRetrieval({
        retrieval,
        rerankerEnabled: input.jarvisConfig.reranker?.enabled === true,
        rerankerThreshold:
          input.jarvisConfig.reranker?.memoryRelevanceThreshold ?? -2,
      });
      if (prewarmCandidates.length > 0) {
        console.error(
          `🧠 [prewarm] subject=${querySubject}, limit=${memoryPolicy.prewarmLimit}, maxDist=${memoryPolicy.prewarmMaxDistance}, injected=${prewarmCandidates.length}` +
            ":\n" +
            prewarmCandidates
              .map(
                (m, i) =>
                  `  [${i + 1}] score=${m.score.toFixed(3)} ${m.text.slice(0, 100)}`,
              )
              .join("\n"),
        );
      }
      retrievalCandidateCounts = {
        facts: facts.length,
        summary: summaryCandidates.length,
        prewarm: prewarmCandidates.length,
      };
      injectionPlan = input.buildMemoryInjectionPlanner().buildPlan({
        querySubject,
        factCandidates: facts.map((fact) => ({
          category: fact.category,
          content: fact.content,
        })),
        summaryCandidates,
        prewarmCandidates,
        maxPrewarmItems: memoryPolicy.reasons.includes(
          "time_scoped_conversation_history",
        )
          ? Math.max(memoryPolicy.prewarmLimit, 8)
          : undefined,
      });
      return {
        text:
          injectionPlan.relevantSummarySection + injectionPlan.prewarmSection,
        usedChars: injectionPlan.usedChars,
        injected: {
          session: injectionPlan.summaryInjected,
          facts: injectionPlan.factsInjected,
          entries: injectionPlan.prewarmInjected,
        },
        rejected: injectionPlan.rejected.map((item) => ({
          scope:
            item.source === "summary"
              ? ("session" as const)
              : item.source === "fact"
                ? ("fact" as const)
                : ("entry" as const),
          reason: item.reason,
          text: item.text,
        })),
        trace: memoryPolicy.contract.policyTrace,
      } satisfies MemoryInjectionResult;
    },
    observe: (event) => {
      input.runtimeIntentFeedbackCollector.recordMemoryEvent({
        ...event,
        sessionId: input.sessionId,
      });
    },
  });

  const agentRuntime = new AgentRuntime(
    new DefaultIntentRuntime(
      new StaticIntentResolverAdapter(async () => runtimeIntent, "jarvis"),
    ),
    memoryRuntime as unknown as DefaultMemoryRuntime<IntentFrame>,
    input.jarvisConfig.agentRuntime?.executionMode === "execute" &&
    !taskGraphExecutionEnabled
      ? (new IntentExecutor(input.toolRouter) as any)
      : undefined,
    {
      executionMode: input.jarvisConfig.agentRuntime?.executionMode ?? "skip",
      skillLimit: skillSearchLimit,
      skillMaxDistance,
      skillRuntime: {
        retrieve: async ({ context, limit, maxDistance }) => {
          relevantSkills = await skillRetrievalExtension.retrieveSkills({
            prompt: context.userPrompt,
            limit: limit ?? skillSearchLimit,
            maxDistance: maxDistance ?? skillMaxDistance,
            context: {
              prompt: context.userPrompt,
              history: input.conversationHistory,
              intent: context.intent,
            },
          });
          return relevantSkills.map(
            (skill): RuntimeSkill => ({
              name: skill.name,
              description: skill.description,
              content: (skill as SkillInfo & { content?: string }).content,
              metadata: { source: "jarvis_skill_index" },
            }),
          );
        },
      },
      stepMemoryPlanner: ({ contract, intent }) => {
        const decisions = buildStepMemoryDecisions({ intent, contract });
        input.toolRouter.setCurrentMemoryContract(contract);
        input.toolRouter.setCurrentStepMemoryDecisions(decisions);
        return decisions;
      },
      responseComposer: {
        compose: async ({ context }) => {
          const contract = context.memoryContract;
          if (!memoryPolicy || !injectionPlan) {
            throw new Error(
              "Memory runtime did not produce an injection plan before response composition",
            );
          }
          const taskGraphInstruction =
            context.taskGraphExecution?.execution.finalResponseContract
              .instruction ?? "";
          const executionInstruction =
            taskGraphInstruction ||
            (context.execution?.finalResponseContract.instruction ?? "");
          const memoryDecision =
            contract?.subjectBoundary === "external"
              ? "Runtime memory boundary: external request; do not use personal memory unless explicitly provided."
              : "";
          const executionContract = executionInstruction
            ? `<runtime_execution_contract>\n${executionInstruction}\n</runtime_execution_contract>`
            : "";
          const taskArtifactSection = buildTaskGraphArtifactSection(
            context.taskGraphExecution,
            context.userPrompt,
          );
          const taskGraphToolPolicy = buildTaskGraphToolPolicySection(
            context.taskGraphExecution,
          );
          const temporalRecallBoundary = buildTemporalRecallBoundary(contract);
          const protocol = input.promptBuilder.buildFromFacts(
            injectionPlan.facts,
            input.userPrompt,
            relevantSkills,
          );
          const intentPlanSection = buildIntentPlanSection(input.intent);
          return {
            text: "",
            systemContext: [
              defaultInstruction,
              protocol,
              intentPlanSection,
              memoryDecision,
              taskArtifactSection,
              taskGraphToolPolicy,
              executionContract,
              temporalRecallBoundary,
              injectionPlan.relevantSummarySection,
              injectionPlan.prewarmSection,
            ]
              .filter(Boolean)
              .join("\n\n"),
            instructions: [executionInstruction].filter(Boolean),
            canClaimSuccess:
              context.taskGraphExecution?.execution.finalResponseContract
                .canClaimSuccess ??
              context.execution?.finalResponseContract.canClaimSuccess ??
              true,
            metadata: { source: "jarvis_agent_runtime" },
          };
        },
      },
      taskRuntime: createJarvisTaskRuntime({
        config: input.jarvisConfig,
        toolRouter: input.toolRouter,
        sessionId: input.sessionId,
        memoryRecall: (contract) => memoryRuntime.retrieve(contract),
      }),
      deferMemoryRetrievalForTaskGraph: taskGraphExecutionEnabled,
      observer: (event) => {
        if (input.jarvisConfig.agentRuntime?.observability === true) {
          console.error(`[AgentRuntime] ${event.type}`);
        }
      },
      ...(input.llmRuntime
        ? {
            llmLoop: input.llmRuntime.options,
          }
        : {}),
    },
  );
  const runtimeResult = await agentRuntime.handleTurn({
    sessionId: input.sessionId,
    userPrompt: input.userPrompt,
    history: input.conversationHistory,
    executionContext: "interactive",
    interactiveChannel: input.interactiveChannel,
    currentContent: input.currentContent,
    artifacts: input.artifacts,
    llmInitialMessages: input.llmRuntime?.initialMessages,
    llmSystemContext: undefined,
    signal: input.llmRuntime?.signal,
  });

  if (!memoryPolicy || !injectionPlan) {
    throw new Error("Memory runtime did not produce an injection plan");
  }
  if (
    retrievalCandidateCounts.facts > 0 ||
    retrievalCandidateCounts.summary > 0 ||
    retrievalCandidateCounts.prewarm > 0
  ) {
    const rejectedPreview = injectionPlan.rejected
      .slice(0, 5)
      .map((item) => `${item.source}/${item.reason}: ${item.text.slice(0, 80)}`)
      .join("\n  ");
    console.error(
      `🧠 [MemoryInjectionPlanner] candidates(facts=${retrievalCandidateCounts.facts}, summary=${retrievalCandidateCounts.summary}, prewarm=${retrievalCandidateCounts.prewarm}) → injected(facts=${injectionPlan.factsInjected}, summary=${injectionPlan.summaryInjected}, prewarm=${injectionPlan.prewarmInjected}), chars=${injectionPlan.usedChars}, rejected=${injectionPlan.rejected.length}` +
        (rejectedPreview ? `\n  ${rejectedPreview}` : ""),
    );
  }

  const protocol = input.promptBuilder.buildFromFacts(
    injectionPlan.facts,
    input.userPrompt,
    relevantSkills,
  );
  const intentPlanSection = buildIntentPlanSection(input.intent);
  const temporalRecallBoundary = buildTemporalRecallBoundary(
    runtimeResult.context.memoryContract,
  );
  const taskArtifactSectionForLog = buildTaskGraphArtifactSection(
    runtimeResult.context.taskGraphExecution,
  );
  const taskArtifacts =
    runtimeResult.context.taskGraphExecution?.execution.artifacts ?? [];
  const taskMemoryItemCount = taskArtifacts.reduce(
    (count, artifact) => count + (artifact.memoryItems?.length ?? 0),
    0,
  );
  const taskArtifactContentLog = shouldLogTaskGraphArtifactContent(
    input.jarvisConfig,
  )
    ? formatTaskGraphArtifactContentLog(taskArtifacts)
    : "";
  if (taskArtifactContentLog) {
    console.error(taskArtifactContentLog);
  }
  const fallbackSystemInstruction =
    defaultInstruction +
    "\n" +
    protocol +
    intentPlanSection +
    temporalRecallBoundary +
    injectionPlan.relevantSummarySection +
    injectionPlan.prewarmSection;

  console.error(
    `🔄 [Jarvis] System Prompt Refreshed (subject=${querySubject}, memoryPolicy=${memoryPolicy.reasons.join(",") || "enabled"}). Facts injected: ${injectionPlan.factsInjected}/${retrievalCandidateCounts.facts}. Summary bullets: ${injectionPlan.summaryInjected}. Prewarmed memories: ${memoryPolicy.allowPrewarm ? injectionPlan.prewarmInjected : "disabled"}. Memory chars: ${injectionPlan.usedChars}. Task artifacts: ${taskArtifacts.length}, task artifact chars: ${taskArtifactSectionForLog.length}, task memory items: ${taskMemoryItemCount}. Rejected: ${injectionPlan.rejected.length}.`,
  );

  return {
    memoryContract: runtimeResult.context.memoryContract!,
    stepMemoryDecisions: runtimeResult.context.stepMemoryDecisions,
    llmLoop: runtimeResult.context.llmLoop,
    taskGraph: runtimeResult.context.taskGraph,
    taskGraphExecution: runtimeResult.context.taskGraphExecution,
    systemInstruction:
      runtimeResult.response.systemContext || fallbackSystemInstruction,
  };
}
