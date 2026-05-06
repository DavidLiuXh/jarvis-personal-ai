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

# Core Mandates

## Security & System Integrity
- **Credential Protection:** Never log, print, or commit secrets, API keys, or sensitive credentials. Rigorously protect \`.env\` files and system configuration.
- **Source Control:** Do not stage or commit changes unless specifically requested by the user.

## Context Efficiency
- Minimize unnecessary turns. Execute multiple independent tool calls in parallel when feasible.
- Prefer targeted searches over reading large files. Read the minimum required to avoid extra turns.

<estimating_context_usage>
- The full conversation history is sent with every message. A large context early in a session makes every subsequent turn more expensive.
- Unnecessary extra turns are generally more costly than large tool outputs — avoid round-trips where one well-scoped call would suffice.
- Limiting tool output size is good, but not at the cost of triggering additional turns to recover missing information.
</estimating_context_usage>

## Tool Usage
- **Parallelism & Sequencing:** Execute independent tool calls in parallel when feasible. If one action depends on a previous tool result, wait for that result before issuing the next action.
- **File Editing Collisions:** Avoid overlapping edits to the same file at the same time. Prefer one coherent edit path per file so changes remain stable and reviewable.
- **Command Execution:** Use the shell tool for running commands. Before executing commands that modify the file system or system state, briefly explain the command's purpose and impact.
- **Background Processes:** Use the runtime's supported background-task mechanism when work should continue asynchronously without blocking the current conversation.
- **Interactive Commands:** Prefer non-interactive commands (e.g. \`git --no-pager\`) unless a persistent process is specifically required.
- **Confirmation Protocol:** If a tool call is declined or cancelled, respect the decision immediately. Do not re-attempt unless the user explicitly directs you to.

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

const PUSH_STRONG_PATTERNS = [
  "发到微信",
  "发到飞书",
  "推送到微信",
  "推送到飞书",
  "send to wechat",
  "send to feishu",
  "push to wechat",
  "push to feishu",
  "share on wechat",
  "share on feishu",
];

const PUSH_ACTION_KEYWORDS = [
  "发到",
  "推送到",
  "send to",
  "push to",
  "share on",
];
const PUSH_TARGET_KEYWORDS = ["微信", "飞书", "wechat", "feishu"];

const TASK_STRONG_PATTERNS = [
  "每天",
  "每周",
  "每月",
  "每日",
  "定时",
  "每隔",
  "scheduled",
  "cron",
];

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
  "重构",
  "实现",
  "edit",
  "modify",
  "refactor",
  "rewrite",
  "implement",
];

const CODE_TARGET_KEYWORDS = ["代码", "函数", "方法", "模块", "接口", "code"];

function matchesAny(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

function countMatches(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  return keywords.filter((kw) => lower.includes(kw)).length;
}

function shouldInjectPushProtocol(text: string): boolean {
  return (
    matchesAny(text, PUSH_STRONG_PATTERNS) ||
    (countMatches(text, PUSH_ACTION_KEYWORDS) > 0 &&
      countMatches(text, PUSH_TARGET_KEYWORDS) > 0)
  );
}

function shouldInjectTaskProtocol(text: string): boolean {
  return (
    matchesAny(text, TASK_STRONG_PATTERNS) ||
    (countMatches(text, TASK_TIME_KEYWORDS) > 0 &&
      countMatches(text, TASK_ACTION_KEYWORDS) > 0)
  );
}

function shouldInjectCodeProtocol(text: string): boolean {
  return (
    matchesAny(text, CODE_STRONG_PATTERNS) ||
    (countMatches(text, CODE_ACTION_KEYWORDS) > 0 &&
      countMatches(text, CODE_TARGET_KEYWORDS) > 0)
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
      `\n<memory_status>\n[INSTRUCTION]: Long-term memory is not pre-loaded into this context window. ` +
      `Do not reference past events unless they appear in <persistent_context> or <relevant_past_conversations>. ` +
      `If the user asks about past conversations: ` +
      `(1) First check <relevant_past_conversations> — if the answer is there, use it directly without calling any tool. ` +
      `(2) Only if <relevant_past_conversations> does not contain the needed information, call 'recall_memory' with the TOPIC keywords from the user's question as the query (e.g. user asks "did we discuss Hormuz?" → query="Hormuz"; user asks "what was my plan for the project?" → query="project plan"). ` +
      `(3) save_memory: facts and preferences are auto-distilled — only call save_memory when the user explicitly says "remember this". ` +
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
      `(3) save_memory: facts and preferences are auto-distilled — only call save_memory when the user explicitly says "remember this". ` +
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
   - Prefer the smallest coherent change that fully solves the user's request.
   - Preserve unrelated logic, imports, error handling, and comments unless the task requires changing them.
   - Before making broad structural edits, first understand the surrounding code so you do not remove behavior the user did not ask to change.
   - If a large rewrite is genuinely the clearest solution, keep the behavior consistent and make the scope of the rewrite intentional rather than incidental.`);
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
- Use GitHub-flavored Markdown. Responses are rendered in monospace. For financial/data analysis, use tables. For code, specify language and file path.
- Use tools for actions; text output only for communication.${styleSection}`.trim();
  }
}
