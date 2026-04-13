/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type FactRecord = {
  category: string;
  content: string;
};

export type SkillInfo = {
  name: string;
  description: string;
};

const TECHNICAL_IDENTITY_KEYWORDS = [
  'engineer', 'engineering', 'coding', 'developer', 'programmer', 'software',
  'architect', 'devops', 'data scientist', 'researcher', 'technical',
];

function deriveStyleFromIdentity(identityFacts: FactRecord[]): string | null {
  const combined = identityFacts.map(f => f.content.toLowerCase()).join(' ');
  const isTechnical = TECHNICAL_IDENTITY_KEYWORDS.some(kw => combined.includes(kw));
  if (isTechnical) {
    return 'User is a technical professional (engineer/developer) — use technical language, assume coding knowledge, skip basic explanations unless asked.';
  }
  return null;
}

const PUSH_KEYWORDS = ['发到', '推送到', '推送', 'send to', 'push to', 'push', '微信', '飞书', 'wechat', 'feishu', 'share on'];
const TASK_KEYWORDS = ['每天', '每周', '每月', '定时', '每隔', '任务', 'task', 'scheduled', 'cron', 'remind', '提醒', '自动', 'automatically', '每日'];
const CODE_KEYWORDS = ['修改', '重写', '编辑', '代码', 'edit', 'modify', 'refactor', 'rewrite', 'file', '文件', 'function', '函数', 'class', '类', 'implement', '实现'];

function matchesAny(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some(kw => lower.includes(kw));
}

type ProtocolSet = {
  pushToChannel: boolean;
  taskManagement: boolean;
  codeModification: boolean;
};

function selectProtocols(userPrompt?: string): ProtocolSet {
  if (!userPrompt || !userPrompt.trim()) {
    return { pushToChannel: true, taskManagement: true, codeModification: true };
  }
  return {
    pushToChannel: matchesAny(userPrompt, PUSH_KEYWORDS),
    taskManagement: matchesAny(userPrompt, TASK_KEYWORDS),
    codeModification: matchesAny(userPrompt, CODE_KEYWORDS),
  };
}

export class SystemPromptBuilder {
  buildFromFacts(facts: FactRecord[], userPrompt?: string, skills: SkillInfo[] = []): string {
    const identityFacts = facts.filter(f => f.category === 'identity');
    const preferenceFacts = facts.filter(f => f.category === 'preference');
    const contextFacts = facts.filter(f => f.category !== 'preference');

    const derivedStyle = deriveStyleFromIdentity(identityFacts);

    let styleSection = '';
    if (derivedStyle || preferenceFacts.length > 0) {
      const lines: string[] = [];
      if (derivedStyle) lines.push(`- [DEFAULT]: ${derivedStyle}`);
      if (preferenceFacts.length > 0) {
        if (derivedStyle) lines.push('  // [USER_PREFERENCE] overrides [DEFAULT] when they conflict:');
        preferenceFacts.forEach(f => lines.push(`- [USER_PREFERENCE]: ${f.content}`));
      }
      styleSection = `\n<style_constraints>\n${lines.join('\n')}\n</style_constraints>`;
    }

    const contextLines = contextFacts.length > 0
      ? contextFacts.map(f => `- [${f.category.toUpperCase()}]: ${f.content}`).join('\n')
      : '(No persistent facts)';

    const memoryContext = `\n<persistent_context>\n${contextLines}\n</persistent_context>\n\n<memory_status>\n[STRICT]: LONG-TERM LOGS NOT LOADED.\nIf the user refers to past conversations, decisions, or "what we did before", use 'recall_memory'. DO NOT HALLUCINATE PAST EVENTS.\n</memory_status>`;

    const protocols = selectProtocols(userPrompt);
    return this.framework(memoryContext + styleSection, protocols, skills);
  }

  build(coreFacts: string[]): string {
    const contextLines = coreFacts.length > 0
      ? coreFacts.map(f => `- ${f}`).join('\n')
      : '(No persistent facts)';

    const memoryContext = `\n<persistent_context>\n${contextLines}\n</persistent_context>\n\n<memory_status>\n[STRICT]: LONG-TERM LOGS NOT LOADED.\nIf the user refers to past conversations, decisions, or "what we did before", use 'recall_memory'. DO NOT HALLUCINATE PAST EVENTS.\n</memory_status>`;

    return this.framework(memoryContext, { pushToChannel: true, taskManagement: true, codeModification: true });
  }

  private framework(memoryContext: string, protocols: ProtocolSet, skills: SkillInfo[] = []): string {
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
   - BAD: run_shell_command("task_delete ...") ← ABSOLUTELY FORBIDDEN
   - GOOD: Call the task_list function tool directly ← CORRECT
   - TRIGGER: When user says "每天X点", "每周X", "定时", "scheduled", "automatically at X time" → call task_add function tool IMMEDIATELY.
   - TRIGGER: When user asks about/deletes/updates tasks → call task_list/task_delete/task_update function tools directly.
   - FORBIDDEN: run_shell_command with crontab, launchctl, launchd, task_list, task_add, or any task_* name.
   - BAD: User says "每天晚上8点查询GitHub Trending" → writing code/scripts/launchd ← WRONG
   - GOOD: User says "每天晚上8点查询GitHub Trending" → task_add(cron="每天晚上8点", prompt="使用google_web_search查询GitHub Trending今日热门并汇总") ← CORRECT
   - NOTE: The prompt in task_add is executed by Jarvis at runtime using available tools — no code needed.`);
    }

    sections.push(`${n++}. **TASK_DECOMPOSITION**:
   - For complex queries, decompose into functional blocks before executing.
   - Trigger specialized modules (codebase_investigator, generalist) concurrently when applicable.`);

    sections.push(`${n++}. **ACTIVE_RECALL (MANDATORY)**:
   - Your context window is fresh on each session.
   - When the user refers to past interactions, ALWAYS call 'recall_memory' first. DO NOT GUESS.`);

    if (skills.length > 0) {
      sections.push(`${n++}. **SKILL_ACTIVATION (USE WHEN APPLICABLE)**:
   - The following skills are available via activate_skill tool. Call activate_skill(name) when the user's request matches a skill's description.
   - After activation, follow the skill's instructions precisely.
<available_skills>
${skills.map(s => `- ${s.name}: ${s.description}`).join('\n')}
</available_skills>`);
    }

    return `# JARVIS OPERATIONAL FRAMEWORK v4.0

## I. CORE PROTOCOLS (MANDATORY)

${sections.join('\n\n')}

## II. EXECUTION CONTEXT
${memoryContext}

## III. ROLE & TONE
- You are JARVIS: deterministic, precise, and system-native.
- Skip conversational fillers. Use high-density information.
- Adapt style as per the style constraints section above if present.

## IV. RESPONSE FORMATTING
- Use Markdown for structure.
- For financial/data analysis, use tables for comparison.
- For code, specify language and file path.`.trim();
  }
}
