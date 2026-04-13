/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type SkillInfo = { name: string; description: string };

type SetAvailableSkillsFn = (skills: SkillInfo[]) => void;
type ReloadSkillManagerFn = () => Promise<void>;
type LoadSkillsFn = () => Promise<SkillInfo[]>;

const HELP = `
🎯 Skill commands (usage):
  !skill list    — List currently loaded skills
  !skill reload  — Rescan skill directories and reload without restart
`.trim();

/**
 * Handles !skill commands for dynamic skill management.
 */
export class SkillCommandHandler {
  private currentSkills: SkillInfo[];

  constructor(
    private setAvailableSkills: SetAvailableSkillsFn,
    private reloadSkillManager: ReloadSkillManagerFn,
    private loadSkills: LoadSkillsFn,
    initialSkills: SkillInfo[] = [],
  ) {
    this.currentSkills = initialSkills;
  }

  public setCurrentSkills(skills: SkillInfo[]): void {
    this.currentSkills = skills;
  }

  public async handle(input: string): Promise<string> {
    const trimmed = input.trim();
    if (!trimmed.startsWith('!skill')) return '';

    const subcommand = trimmed.slice('!skill'.length).trim().split(/\s+/)[0]?.toLowerCase();

    switch (subcommand) {
      case 'list': return this.list();
      case 'reload': return this.reload();
      default: return `Unknown subcommand "${subcommand}".\n\n${HELP}`;
    }
  }

  private list(): string {
    if (this.currentSkills.length === 0) {
      return `📋 No skills loaded.\n\nUse !skill reload to scan skill directories.`;
    }
    const lines = this.currentSkills.map(s => `  • **${s.name}**: ${s.description}`);
    return `📋 Loaded skills (${this.currentSkills.length}):\n\n${lines.join('\n')}`;
  }

  private async reload(): Promise<string> {
    console.error('🔄 [SkillCommandHandler] Reloading skills...');
    try {
      const [skills] = await Promise.all([
        this.loadSkills(),
        this.reloadSkillManager(),
      ]);

      this.currentSkills = skills;
      this.setAvailableSkills(skills);

      if (skills.length === 0) {
        return `✅ Skills reloaded: 0 skills found.\n\nAdd SKILL.md files to ~/.gemini/skills/ or ~/.agents/skills/`;
      }

      const names = skills.map(s => s.name).join(', ');
      return `✅ Skills reloaded: ${skills.length} skill(s) loaded.\n\n${names}`;
    } catch (e: any) {
      console.error(`⚠️ [SkillCommandHandler] Reload failed: ${e.message}`);
      return `❌ Skill reload failed: ${e.message}`;
    }
  }
}
