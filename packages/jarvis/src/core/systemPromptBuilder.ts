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
 * Builds the Jarvis system prompt by combining the operational framework
 * with the current persistent memory facts.
 */
export class SystemPromptBuilder {
  /** Legacy: accepts pre-formatted "[category] content" strings. */
  build(coreFacts: string[]): string {
    const memoryContext = `
# SYSTEM-INTEGRATED PERSISTENT CONTEXT (Global Identity):
${coreFacts.length > 0 ? coreFacts.map(f => `- ${f}`).join('\n') : '(No persistent facts stored)'}

# COGNITIVE MEMORY STATUS:
[WARNING]: LONG-TERM INTERACTION LOGS ARE NOT LOADED.
If the current prompt refers to past conversations, previous technical details, or "what we did before", you MUST call 'recall_memory' to look up the data. DO NOT GUESS.
`;

    return this.framework(memoryContext);
  }

  /** Preferred: accepts structured FactRecord[], renders adaptive style instructions. */
  buildFromFacts(facts: FactRecord[]): string {
    const identityFacts = facts.filter(f => f.category === 'identity');
    const preferenceFacts = facts.filter(f => f.category === 'preference');
    const behaviorFacts = facts.filter(f => f.category === 'behavior');
    // behavior goes to PERSISTENT CONTEXT (lifestyle info), not STYLE INSTRUCTIONS
    const contextFacts = facts.filter(f => f.category !== 'preference');

    // Derive default style from identity (inferred, lower priority)
    const derivedStyle = deriveStyleFromIdentity(identityFacts);

    // Only preference facts are explicit style instructions (behavior = lifestyle, not response style)
    const explicitStyleFacts = preferenceFacts;

    // Build style section only when there's something to say
    let styleSection = '';
    if (derivedStyle || explicitStyleFacts.length > 0) {
      const lines: string[] = [];

      if (derivedStyle) {
        lines.push(`## Default style (inferred from user profile):`);
        lines.push(`- ${derivedStyle}`);
      }

      if (explicitStyleFacts.length > 0) {
        if (derivedStyle) {
          lines.push('');
          lines.push(`## User preferences (explicit — override defaults when they conflict):`);
        }
        explicitStyleFacts.forEach(f => lines.push(`- ${f.content}`));
      }

      styleSection = `
# STYLE INSTRUCTIONS (MANDATORY — apply to every response):
${lines.join('\n')}
`;
    }

    const memoryContext = `
# PERSISTENT CONTEXT (Global Identity):
${contextFacts.length > 0 ? contextFacts.map(f => `- [${f.category}] ${f.content}`).join('\n') : '(No persistent facts stored)'}

# COGNITIVE MEMORY STATUS:
[WARNING]: LONG-TERM INTERACTION LOGS ARE NOT LOADED.
If the current prompt refers to past conversations, previous technical details, or "what we did before", you MUST call 'recall_memory' to look up the data. DO NOT GUESS.
`;

    return this.framework(memoryContext + styleSection);
  }

  private framework(memoryContext: string): string {
    return `
# JARVIS SYSTEM OPERATIONAL FRAMEWORK v3.0 (ACTIVE COGNITION)
You are JARVIS, an advanced system-native operative.

## I. MEMORY ARCHITECTURE (MANDATORY)
1. **ACTIVE RECALL**: Your current context window is fresh. To provide accurate continuity, you MUST use 'recall_memory' whenever past knowledge is required.
2. **EXAMPLE**:
   - User: "What was the React optimization we discussed?"
   - Action: call recall_memory({ query: "React optimization" })
3. **KNOWLEDGE SYNTHESIS**: Use 'save_memory' to commit new rules or preferences.

## II. AUTOMATIC TASK DECOMPOSITION
1. **DECOMPOSE FIRST**: Immediately partition complex missions into functional blocks.
2. **CONCURRENT DISPATCH**: Trigger specialized modules (e.g., codebase_investigator, generalist) SIMULTANEOUSLY.

## III. OPERATIONAL STYLE
- Be precise. Be deterministic.
- Leverage system-native autonomy to resolve missions without redundant verification.

${memoryContext}
`;
  }
}
