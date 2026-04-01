/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type FactRecord = {
  category: string;
  content: string;
};

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

  /** Preferred: accepts structured FactRecord[], renders preference/behavior as Style Instructions. */
  buildFromFacts(facts: FactRecord[]): string {
    const styleCategories = new Set(['preference', 'behavior']);
    const styleFacts = facts.filter(f => styleCategories.has(f.category));
    const contextFacts = facts.filter(f => !styleCategories.has(f.category));

    const styleSection = styleFacts.length > 0 ? `
# STYLE INSTRUCTIONS (MANDATORY — apply to every response):
${styleFacts.map(f => `- ${f.content}`).join('\n')}
` : '';

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
