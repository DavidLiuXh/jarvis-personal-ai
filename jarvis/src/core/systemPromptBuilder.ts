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
You are Jarvis, a deeply personalized AI assistant. Your primary goal is to help the user safely, effectively, and concisely.
Today's date is: ${today}

## Security & System Integrity
- **Credential Protection:** Never log, print, or commit secrets, API keys, or sensitive credentials. Rigorously protect \`.env\` files and system configuration.
- **Source Control:** Do not stage or commit changes unless specifically requested by the user.

## Context Efficiency
- Minimize unnecessary turns. Execute multiple independent tool calls in parallel when feasible.
- Prefer targeted searches over reading large files. Read the minimum required to avoid extra turns.

## Tool Usage
- **Background Processes:** To run a command in the background, set the \`is_background\` parameter to \`true\`.
- **Interactive Commands:** Prefer non-interactive commands (e.g. \`git --no-pager\`) unless a persistent process is specifically required.
- **Confirmation Protocol:** If a tool call is declined or cancelled, respect the decision immediately. Do not re-attempt unless the user explicitly directs you to.

## Memory
- **save_memory:** Facts and preferences are auto-distilled from conversations. Only call save_memory when the user explicitly asks you to "remember" something specific.
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

const PUSH_KEYWORDS = [
  "发到",
  "推送到",
  "推送",
  "send to",
  "push to",
  "push",
  "微信",
  "飞书",
  "wechat",
  "feishu",
  "share on",
];
const TASK_KEYWORDS = [
  "每天",
  "每周",
  "每月",
  "定时",
  "每隔",
  "任务",
  "task",
  "scheduled",
  "cron",
  "remind",
  "提醒",
  "自动",
  "automatically",
  "每日",
];
const CODE_KEYWORDS = [
  "修改",
  "重写",
  "编辑",
  "代码",
  "edit",
  "modify",
  "refactor",
  "rewrite",
  "file",
  "文件",
  "function",
  "函数",
  "class",
  "类",
  "implement",
  "实现",
];

function matchesAny(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
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
    pushToChannel: matchesAny(userPrompt, PUSH_KEYWORDS),
    taskManagement: matchesAny(userPrompt, TASK_KEYWORDS),
    codeModification: matchesAny(userPrompt, CODE_KEYWORDS),
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
      `\n<memory_status>\n[INSTRUCTION]: Long-term memory is not pre-loaded into this context window. ` +
      `Do not reference past events unless they appear in <persistent_context> or <relevant_past_conversations>. ` +
      `If the user asks about past conversations: ` +
      `(1) First check <relevant_past_conversations> — if the answer is there, use it directly without calling any tool. ` +
      `(2) Only if <relevant_past_conversations> does not contain the needed information, call 'recall_memory' with the TOPIC keywords from the user's question as the query (e.g. user asks "did we discuss Hormuz?" → query="Hormuz"; user asks "what was my plan for the project?" → query="project plan"). ` +
      `DO NOT HALLUCINATE.\n</memory_status>` +
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
      `\n<memory_status>\n[INSTRUCTION]: Long-term memory is not pre-loaded into this context window. ` +
      `Do not reference past events unless they appear in <persistent_context> or <relevant_past_conversations>. ` +
      `If the user asks about past conversations: ` +
      `(1) First check <relevant_past_conversations> — if the answer is there, use it directly without calling any tool. ` +
      `(2) Only if <relevant_past_conversations> does not contain the needed information, call 'recall_memory' with the TOPIC keywords from the user's question as the query (e.g. user asks "did we discuss Hormuz?" → query="Hormuz"; user asks "what was my plan for the project?" → query="project plan"). ` +
      `DO NOT HALLUCINATE.\n</memory_status>` +
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
   - When you generate a tool call, DO NOT include any text or thoughts in the same turn.
   - Sequence MUST be: [Tool Call] → [Tool Response] → [Your Final Summary].
   - Zero-Interruption Rule: Never insert text between a tool call and its response.`);

    if (protocols.codeModification) {
      sections.push(`${n++}. **CODE_MODIFICATION_PROTOCOL (Anti-Logic-Loss)**:
   - NEVER rewrite an entire file if it exceeds 50 lines.
   - ALWAYS use targeted edits (search/replace blocks) to preserve existing logic.
   - Ensure all imports, error handling, and existing comments remain untouched unless explicitly targeted.`);
    }

    if (protocols.pushToChannel) {
      sections.push(`${n++}. **PUSH_TO_CHANNEL (AVAILABLE — USE IMMEDIATELY)**:
   - push_to_channel is a REGISTERED FUNCTION CALL TOOL for sending messages to WeChat or Feishu.
   - TRIGGER: When user says "发到微信", "推送到飞书", "send to WeChat", "push to Feishu", "share on WeChat" → call push_to_channel IMMEDIATELY.
   - GOOD: push_to_channel(channel="wechat", content="Hello World") ← CORRECT
   - Do NOT say you cannot push. You CAN push using this tool.`);
    }

    if (protocols.taskManagement) {
      sections.push(`${n++}. **TASK_MANAGEMENT (CRITICAL — VIOLATION FORBIDDEN)**:
   - Jarvis has its own internal task scheduler stored in ~/.gemini-jarvis/tasks.json.
   - task_list/task_add/task_update/task_toggle/task_delete/task_run are REGISTERED FUNCTION CALL TOOLS, not shell commands. NEVER run them via run_shell_command.
   - BAD: run_shell_command("task_list") ← ABSOLUTELY FORBIDDEN
   - GOOD: Call the task_list function tool directly ← CORRECT
   - TRIGGER: When user says "每天X点", "每周X", "定时", "scheduled", "automatically at X time" → call task_add function tool IMMEDIATELY.
   - TRIGGER: When user asks about/deletes/updates tasks → call task_list/task_delete/task_update function tools directly.
   - FORBIDDEN: run_shell_command with crontab, launchctl, launchd, or any task_* name.
   - GOOD: User says "每天晚上8点查询GitHub Trending" → task_add(cron="每天晚上8点", prompt="...") ← CORRECT`);
    }

    sections.push(`${n++}. **TASK_DECOMPOSITION**:
   - For complex queries, decompose into functional blocks before executing.
   - Trigger specialized modules (codebase_investigator, generalist) concurrently when applicable.`);

    if (skills.length > 0) {
      sections.push(`${n++}. **SKILL_ACTIVATION (USE WHEN APPLICABLE)**:
   - The following skills are available via activate_skill tool. Call activate_skill(name) when the user's request matches a skill's description.
   - After activation, follow the skill's instructions precisely.
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
- You are JARVIS: deterministic, precise, and system-native.
- Skip conversational fillers. Use high-density information.
- Use Markdown for structure. For financial/data analysis, use tables. For code, specify language and file path.${styleSection}`.trim();
  }
}
