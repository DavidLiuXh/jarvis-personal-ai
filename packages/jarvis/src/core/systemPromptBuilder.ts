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
 * Builds the Jarvis Absolute Protocol based on distilled facts and compressed history.
 */
export class SystemPromptBuilder {
  public build(facts: string[]): string {
    const records: FactRecord[] = facts.map(f => {
      const match = f.match(/\[(.*?)\] (.*)/);
      return match ? { category: match[1], content: match[2] } : { category: 'general', content: f };
    });
    return this.buildFromFacts(records, '', '');
  }

  public buildFromFacts(
    facts: FactRecord[], 
    summary: string = '', 
    structuredContext: string = '', 
    isProactive: boolean = false
  ): string {
    const memoryContext = facts
      .filter(f => f.category !== 'preference')
      .map(f => `- [${f.category}] ${f.content}`)
      .join('\n') || '(No persistent facts stored)';

    // STYLE INSTRUCTIONS
    const preferences = facts.filter(f => f.category === 'preference');
    const identities = facts.filter(f => f.category === 'identity');
    
    const hasTechnicalIdentity = identities.some(i => 
      /engineer|developer|coder|technical|professional|expert|adept/i.test(i.content)
    );

    let styleSection = '';
    if (preferences.length > 0 || hasTechnicalIdentity) {
      const styleLines: string[] = [];
      if (preferences.length > 0) {
        preferences.forEach(p => styleLines.push(`- USER PREFERENCE: ${p.content}`));
      } else if (hasTechnicalIdentity) {
        styleLines.push('- INFERRED STYLE (from user profile): Professional, technical, and precise.');
      }
      styleSection = `\n# STYLE INSTRUCTIONS:\n${styleLines.join('\n')}\n`;
    }

    // PROACTIVE SECTION
    const proactiveSection = isProactive ? `
## MISSION CRITICAL (PROACTIVE MODE)
- You are running in BACKGROUND/PROACTIVE mode.
- Do NOT output your final conclusion in the normal text flow.
- You MUST call 'deliver_result' tool at the end of your mission to send the final report.
` : '';

    // 🛠️ RESTORE COMPRESSED HISTORY INJECTION
    const historySection = summary.trim() ? `
# COMPRESSED CONVERSATION HISTORY:
${summary}
` : '';

    const contextSection = structuredContext.trim() ? `
# EXTRACTED USER CONTEXT:
${structuredContext}
` : '';

    return `
# JARVIS SYSTEM OPERATIONAL FRAMEWORK v3.0 (ACTIVE COGNITION)
You are JARVIS, an advanced system-native operative.

## I. MEMORY ARCHITECTURE (MANDATORY)
1. **ACTIVE RECALL**: Your current context window is a rolling snapshot. For continuity, you MUST use 'recall_memory' to fetch specific past details not in the view below.
2. **KNOWLEDGE SYNTHESIS**: Use 'save_memory' to commit new core rules.

${proactiveSection}
${styleSection}
${historySection}
${contextSection}

## II. AUTOMATED HABITS (TASK SCHEDULING)
1. **SELF-SCHEDULING**: Use 'manage_cron_task' to manage !task habits.

## III. AUTOMATIC TASK DECOMPOSITION
1. **DECOMPOSE FIRST**: Partition complex missions into functional blocks.
2. **CONCURRENT DISPATCH**: Trigger specialized modules SIMULTANEOUSLY.

## IV. OPERATIONAL STYLE
- Be precise. Be deterministic. 

# SYSTEM-INTEGRATED PERSISTENT CONTEXT:
${memoryContext}

# COGNITIVE MEMORY STATUS:
[WARNING]: RAW INTERACTION LOGS ARE NOT LOADED. CALL 'recall_memory' IF NEEDED.
`;
  }
}
