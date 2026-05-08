/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Builds a slim preamble that replaces getCoreSystemPrompt().
 * Retains only the parts relevant to Jarvis (personal assistant),
 * dropping software-engineering-specific workflows and sub-agents.
 *
 * @param userMemory - content of GEMINI.md files (global + project), if any
 */
export function buildJarvisPreamble(_userMemory?: string): string {
  const memorySection = "";

  // Inject current date on every turn so long-running sessions always have
  // the correct date, regardless of when the process was started.
  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return `
You are Jarvis, a personalized AI assistant. Help the user safely, effectively, and concisely.
Today's date is: ${today}

# Core Rules
- Protect secrets, credentials, \`.env\`, and system configuration.
- Do not stage or commit changes unless the user explicitly asks.
- Minimize unnecessary turns; prefer one well-scoped action over extra round-trips.
- Use parallel tool calls only when independent; otherwise wait for prior results.
- Keep file changes coherent and avoid overlapping edits to the same file.
- Before state-changing shell commands, briefly state purpose and impact.
- Respect declined confirmations immediately. Use supported background-task mechanisms for async work.

${memorySection}
`.trim();
}

export type FactRecord = {
  category: string;
  content: string;
};

export type SkillInfo = {
  name: string;
  description: string;
};

const TECHNICAL_IDENTITY_KEYWORDS = [
  "engineer",
  "engineering",
  "coding",
  "developer",
  "programmer",
  "software",
  "architect",
  "devops",
  "data scientist",
  "researcher",
  "technical",
];

function deriveStyleFromIdentity(identityFacts: FactRecord[]): string | null {
  const combined = identityFacts.map((f) => f.content.toLowerCase()).join(" ");
  const isTechnical = TECHNICAL_IDENTITY_KEYWORDS.some((kw) =>
    combined.includes(kw),
  );
  if (isTechnical) {
    return "User is a technical professional (engineer/developer) — use technical language, assume coding knowledge, skip basic explanations unless asked.";
  }
  return null;
}

// Push: action keyword + target keyword both required (no separate strong
// patterns needed — every combination is covered by the two-list check).
const PUSH_ACTION_KEYWORDS = [
  "发到",
  "推送到",
  "send to",
  "push to",
  "share on",
];
const PUSH_TARGET_KEYWORDS = ["微信", "飞书", "wechat", "feishu"];

// Task: only inject when BOTH a time keyword AND an action keyword are present.
// TASK_STRONG_PATTERNS was previously a subset of TASK_TIME_KEYWORDS, which
// caused the action-keyword requirement to be bypassed — removed.
const TASK_TIME_KEYWORDS = [
  "每天",
  "每周",
  "每月",
  "每日",
  "定时",
  "每隔",
  "scheduled",
  "cron",
  "automatically",
];

const TASK_ACTION_KEYWORDS = [
  "提醒",
  "remind",
  "自动执行",
  "自动发送",
  "自动汇总",
];

// Code: strong patterns cover unambiguous single-word triggers; action+target
// covers two-word combos. Duplicates between the two lists removed from
// CODE_ACTION_KEYWORDS to avoid dead code.
const CODE_STRONG_PATTERNS = [
  "修改代码",
  "重写代码",
  "编辑代码",
  "重构",
  "refactor",
  "rewrite this",
  "implement",
  "实现这个",
];

const CODE_ACTION_KEYWORDS = [
  "修改",
  "重写",
  "编辑",
  "实现",
  "edit",
  "modify",
  "rewrite",
];

const CODE_TARGET_KEYWORDS = ["代码", "函数", "方法", "模块", "接口", "code"];

function matchesAny(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

function shouldInjectPushProtocol(text: string): boolean {
  return (
    matchesAny(text, PUSH_ACTION_KEYWORDS) &&
    matchesAny(text, PUSH_TARGET_KEYWORDS)
  );
}

function shouldInjectTaskProtocol(text: string): boolean {
  return (
    matchesAny(text, TASK_TIME_KEYWORDS) &&
    matchesAny(text, TASK_ACTION_KEYWORDS)
  );
}

function shouldInjectCodeProtocol(text: string): boolean {
  return (
    matchesAny(text, CODE_STRONG_PATTERNS) ||
    (matchesAny(text, CODE_ACTION_KEYWORDS) &&
      matchesAny(text, CODE_TARGET_KEYWORDS))
  );
}

type ProtocolSet = {
  pushToChannel: boolean;
  taskManagement: boolean;
  codeModification: boolean;
};

function selectProtocols(userPrompt?: string): ProtocolSet {
  if (!userPrompt || !userPrompt.trim()) {
    return {
      pushToChannel: true,
      taskManagement: true,
      codeModification: true,
    };
  }
  return {
    pushToChannel: shouldInjectPushProtocol(userPrompt),
    taskManagement: shouldInjectTaskProtocol(userPrompt),
    codeModification: shouldInjectCodeProtocol(userPrompt),
  };
}

export class SystemPromptBuilder {
  buildFromFacts(
    facts: FactRecord[],
    userPrompt?: string,
    skills: SkillInfo[] = [],
  ): string {
    const identityFacts = facts.filter((f) => f.category === "identity");
    const preferenceFacts = facts.filter(
      (f) => f.category === "interaction_style",
    );
    const nonIdentityFacts = facts.filter(
      (f) => f.category !== "interaction_style" && f.category !== "identity",
    );

    const derivedStyle = deriveStyleFromIdentity(identityFacts);

    // Style constraints (moved to end of framework for recency effect)
    let styleSection = "";
    if (derivedStyle || preferenceFacts.length > 0) {
      const lines: string[] = [];
      if (derivedStyle) lines.push(`- [DEFAULT]: ${derivedStyle}`);
      if (preferenceFacts.length > 0) {
        if (derivedStyle)
          lines.push(
            "  // [USER_PREFERENCE] overrides [DEFAULT] when they conflict:",
          );
        preferenceFacts.forEach((f) =>
          lines.push(`- [USER_PREFERENCE]: ${f.content}`),
        );
      }
      styleSection = `\n<style_constraints>\n${lines.join("\n")}\n</style_constraints>`;
    }

    // persistent_context: identity facts first (primacy), then others
    const identityLines = identityFacts
      .map((f) => `- [IDENTITY]: ${f.content}`)
      .join("\n");
    const otherLines = nonIdentityFacts
      .map((f) => `- [${f.category.toUpperCase()}]: ${f.content}`)
      .join("\n");
    const contextLines =
      identityFacts.length === 0 && nonIdentityFacts.length === 0
        ? "(No persistent facts)"
        : [identityLines, otherLines].filter(Boolean).join("\n");

    const memoryContext =
      `\n<memory_status>\n` +
      `- Only reference past events that appear in <persistent_context> or <relevant_past_conversations>.\n` +
      `- If needed memory is missing, call recall_memory with concise topic keywords.\n` +
      `- Call save_memory only when the user explicitly asks to remember something. Do not hallucinate past context.\n` +
      `</memory_status>` +
      `\n\n<persistent_context>\n${contextLines}\n</persistent_context>`;

    const protocols = selectProtocols(userPrompt);
    return this.framework(memoryContext, styleSection, protocols, skills);
  }

  build(coreFacts: string[]): string {
    const contextLines =
      coreFacts.length > 0
        ? coreFacts.map((f) => `- ${f}`).join("\n")
        : "(No persistent facts)";

    const memoryContext =
      `\n<memory_status>\n` +
      `- Only reference past events that appear in <persistent_context> or <relevant_past_conversations>.\n` +
      `- If needed memory is missing, call recall_memory with concise topic keywords.\n` +
      `- Call save_memory only when the user explicitly asks to remember something. Do not hallucinate past context.\n` +
      `</memory_status>` +
      `\n\n<persistent_context>\n${contextLines}\n</persistent_context>`;

    return this.framework(memoryContext, "", {
      pushToChannel: true,
      taskManagement: true,
      codeModification: true,
    });
  }

  private framework(
    memoryContext: string,
    styleSection: string,
    protocols: ProtocolSet,
    skills: SkillInfo[] = [],
  ): string {
    const sections: string[] = [];
    let n = 1;

    sections.push(`${n++}. **TOOL_USE_ATOMICITY (Anti-400 Error)**:
   - If you emit a tool call, do not mix it with narrative text in the same turn.
   - Use the sequence: tool call → tool response → final answer.`);

    if (protocols.codeModification) {
      sections.push(`${n++}. **CODE_MODIFICATION_PROTOCOL (Anti-Logic-Loss)**:
   - Prefer the smallest coherent change that fully solves the user's request.
   - Preserve unrelated logic, imports, error handling, and comments unless the task requires changing them.
   - Before making broad structural edits, first understand the surrounding code so you do not remove behavior the user did not ask to change.
   - If a large rewrite is genuinely the clearest solution, keep the behavior consistent and make the scope of the rewrite intentional rather than incidental.`);
    }

    if (protocols.pushToChannel) {
      sections.push(`${n++}. **PUSH_TO_CHANNEL (AVAILABLE — USE IMMEDIATELY)**:
   - When the user asks to send content to WeChat or Feishu, call push_to_channel directly.
   - Do not claim this capability is unavailable when the tool is registered.`);
    }

    if (protocols.taskManagement) {
      sections.push(`${n++}. **TASK_MANAGEMENT (CRITICAL — VIOLATION FORBIDDEN)**:
   - Use task_* function tools for scheduling and task management; do not emulate them with shell commands.
   - For create/list/update/delete/run task requests, call the matching task tool directly.`);
    }

    sections.push(`${n++}. **TASK_DECOMPOSITION**:
   - For complex queries, decompose into functional blocks before executing.
   - Trigger specialized modules (codebase_investigator, generalist) concurrently when applicable.`);

    if (skills.length > 0) {
      sections.push(`${n++}. **SKILL_ACTIVATION (USE WHEN APPLICABLE)**:
   - Call activate_skill(name) when the request clearly matches a listed skill, then follow that skill's instructions.
<available_skills>
${skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")}
</available_skills>`);
    }

    // New order: Identity(primacy) → Context → Protocols → Style/Formatting(recency)
    return `# JARVIS OPERATIONAL FRAMEWORK v4.0

## I. EXECUTION CONTEXT
${memoryContext}

## II. OPERATIONAL PROTOCOLS
${sections.join("\n\n")}

## III. OUTPUT CONSTRAINTS
- Be precise, direct, and high-density.
- Skip conversational fillers.
- Use GitHub-flavored Markdown. Use tables for financial/data analysis. For code, specify language and file path when relevant.
- Use tools for actions and text for communication.${styleSection}`.trim();
  }
}
