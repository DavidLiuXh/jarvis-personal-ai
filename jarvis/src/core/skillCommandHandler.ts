/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type SkillInfo = { name: string; description: string };

type SetAvailableSkillsFn = (skills: SkillInfo[]) => void;
type ReloadSkillManagerFn = () => Promise<void>;
type LoadSkillsFn = () => Promise<SkillInfo[]>;

type ExtractSkillsFn = () => Promise<void>;

const HELP = `
🎯 Skill commands (usage):
  !skill list     — List currently loaded skills
  !skill reload   — Rescan skill directories and reload without restart
  !skill extract  — Run confucius now to extract skills from recent sessions
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
    private extractSkills?: ExtractSkillsFn,
  ) {
    this.currentSkills = initialSkills;
  }

  public setCurrentSkills(skills: SkillInfo[]): void {
    this.currentSkills = skills;
  }

  public async handle(input: string): Promise<string> {
    const trimmed = input.trim();
    if (!trimmed.startsWith("!skill")) return "";

    const subcommand = trimmed
      .slice("!skill".length)
      .trim()
      .split(/\s+/)[0]
      ?.toLowerCase();

    switch (subcommand) {
      case "list":
        return this.list();
      case "reload":
        return this.reload();
      case "extract":
        return this.extract();
      default:
        return `Unknown subcommand "${subcommand}".\n\n${HELP}`;
    }
  }

  private list(): string {
    if (this.currentSkills.length === 0) {
      return `📋 No skills loaded.\n\nUse !skill reload to scan skill directories.`;
    }
    const lines = this.currentSkills.map(
      (s) => `  • **${s.name}**: ${s.description}`,
    );
    return `📋 Loaded skills (${this.currentSkills.length}):\n\n${lines.join("\n")}`;
  }

  private async extract(): Promise<string> {
    if (!this.extractSkills) {
      return `❌ Skill extraction not available (extractSkills callback not configured).`;
    }
    console.error(
      "🧠 [SkillCommandHandler] Manual skill extraction triggered...",
    );
    // Run async without blocking — progress logged to stderr
    void this.extractSkills().then(async () => {
      // Auto-reload after extraction so new skills are immediately available
      const skills = await this.loadSkills();
      this.currentSkills = skills;
      this.setAvailableSkills(skills);
    });
    return `🧠 Skill extraction started in background.\n\nconfucius will analyze recent sessions and write any new SKILL.md files to ~/.gemini/skills/.\nRun !skill reload after it completes to pick up new skills.`;
  }

  private async reload(): Promise<string> {
    console.error("🔄 [SkillCommandHandler] Reloading skills...");
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

      const names = skills.map((s) => s.name).join(", ");
      return `✅ Skills reloaded: ${skills.length} skill(s) loaded.\n\n${names}`;
    } catch (e: any) {
      console.error(`⚠️ [SkillCommandHandler] Reload failed: ${e.message}`);
      return `❌ Skill reload failed: ${e.message}`;
    }
  }
}
