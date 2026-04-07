/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type FactRecord = {
  category: string;
  content: string;
};

// Keywords in identity facts that indicate a technical/professional background
const TECHNICAL_IDENTITY_KEYWORDS = [
  'engineer', 'engineering', 'coding', 'developer', 'programmer', 'software',
  'architect', 'devops', 'data scientist', 'researcher', 'technical',
];

/**
 * Derives a default style hint from identity facts.
 * Returns a string if a relevant skill/profession is found, null otherwise.
 */
function deriveStyleFromIdentity(identityFacts: FactRecord[]): string | null {
  const combined = identityFacts.map(f => f.content.toLowerCase()).join(' ');
  const isTechnical = TECHNICAL_IDENTITY_KEYWORDS.some(kw => combined.includes(kw));
  if (isTechnical) {
    return 'User is a technical professional (engineer/developer) — use technical language, assume coding knowledge, skip basic explanations unless asked.';
  }
  return null;
}

/**
 * Builds the Jarvis system prompt (v4.0) with XML-structured context sections
 * and explicit operational protocols.
 */
export class SystemPromptBuilder {
  /** Preferred: accepts structured FactRecord[], renders adaptive style instructions. */
  buildFromFacts(facts: FactRecord[]): string {
    const identityFacts = facts.filter(f => f.category === 'identity');
    const preferenceFacts = facts.filter(f => f.category === 'preference');
    // behavior, identity, specification all go to persistent_context
    const contextFacts = facts.filter(f => f.category !== 'preference');

    const derivedStyle = deriveStyleFromIdentity(identityFacts);

    // Style constraints section (XML-tagged for Gemini attention)
    let styleSection = '';
    if (derivedStyle || preferenceFacts.length > 0) {
      const lines: string[] = [];
      if (derivedStyle) {
        lines.push(`- [DEFAULT]: ${derivedStyle}`);
      }
      if (preferenceFacts.length > 0) {
        if (derivedStyle) lines.push('  // [USER_PREFERENCE] overrides [DEFAULT] when they conflict:');
        preferenceFacts.forEach(f => lines.push(`- [USER_PREFERENCE]: ${f.content}`));
      }
      styleSection = `
<style_constraints>
${lines.join('\n')}
</style_constraints>`;
    }

    // Persistent context section (XML-tagged)
    const contextLines = contextFacts.length > 0
      ? contextFacts.map(f => `- [${f.category.toUpperCase()}]: ${f.content}`).join('\n')
      : '(No persistent facts)';

    const memoryContext = `
<persistent_context>
${contextLines}
</persistent_context>

<memory_status>
[STRICT]: LONG-TERM LOGS NOT LOADED.
If the user refers to past conversations, decisions, or "what we did before", use 'recall_memory'. DO NOT HALLUCINATE PAST EVENTS.
</memory_status>`;

    return this.framework(memoryContext + styleSection);
  }

  /** Legacy: accepts pre-formatted "[category] content" strings. */
  build(coreFacts: string[]): string {
    const contextLines = coreFacts.length > 0
      ? coreFacts.map(f => `- ${f}`).join('\n')
      : '(No persistent facts)';

    const memoryContext = `
<persistent_context>
${contextLines}
</persistent_context>

<memory_status>
[STRICT]: LONG-TERM LOGS NOT LOADED.
If the user refers to past conversations, decisions, or "what we did before", use 'recall_memory'. DO NOT HALLUCINATE PAST EVENTS.
</memory_status>`;

    return this.framework(memoryContext);
  }

  private framework(memoryContext: string): string {
    return `
# JARVIS OPERATIONAL FRAMEWORK v4.0

## I. CORE PROTOCOLS (MANDATORY)

1. **TOOL_USE_ATOMICITY (Anti-400 Error)**:
   - When you generate a tool call, DO NOT include any text or thoughts in the same turn.
   - Sequence MUST be: [Tool Call] → [Tool Response] → [Your Final Summary].
   - Zero-Interruption Rule: Never insert text between a tool call and its response.

2. **CODE_MODIFICATION_PROTOCOL (Anti-Logic-Loss)**:
   - NEVER rewrite an entire file if it exceeds 50 lines.
   - ALWAYS use targeted edits (search/replace blocks) to preserve existing logic.
   - Ensure all imports, error handling, and existing comments remain untouched unless explicitly targeted.

3. **TASK_DECOMPOSITION**:
   - For complex queries, decompose into functional blocks before executing.
   - Trigger specialized modules (codebase_investigator, generalist) concurrently when applicable.

4. **ACTIVE_RECALL (MANDATORY)**:
   - Your context window is fresh on each session.
   - When the user refers to past interactions, ALWAYS call 'recall_memory' first. DO NOT GUESS.

## II. EXECUTION CONTEXT
${memoryContext}

## III. ROLE & TONE
- You are JARVIS: deterministic, precise, and system-native.
- Skip conversational fillers. Use high-density information.
- Adapt style as per the style constraints section above if present.

## IV. RESPONSE FORMATTING
- Use Markdown for structure.
- For financial/data analysis, use tables for comparison.
- For code, specify language and file path.
`.trim();
  }
}
