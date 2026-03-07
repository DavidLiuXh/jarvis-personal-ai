/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { debugLogger } from '../../../core/src/index.js';

export interface EvolvedSkillMetadata {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  executable: string; // Filename of the script
}

/**
 * DynamicToolRegistry manages the "evolution" of Jarvis.
 * It loads scripts from the evolved_skills directory and makes them available as tools.
 */
export class DynamicToolRegistry {
  private skillsPath: string;

  constructor(basePath: string) {
    this.skillsPath = path.join(basePath, 'packages', 'jarvis', 'evolved_skills');
    if (!fs.existsSync(this.skillsPath)) {
      fs.mkdirSync(this.skillsPath, { recursive: true });
    }
  }

  /**
   * Scans the directory and returns tool definitions for Gemini.
   */
  public getDynamicToolSchemas(): any[] {
    const tools: any[] = [];
    try {
      const files = fs.readdirSync(this.skillsPath);
      const metaFiles = files.filter(f => f.endsWith('.json'));

      for (const metaFile of metaFiles) {
        try {
          const content = fs.readFileSync(path.join(this.skillsPath, metaFile), 'utf8');
          const meta = JSON.parse(content) as EvolvedSkillMetadata;
          
          // Map to Gemini function declaration format
          tools.push({
            name: `run_evolved_skill_${meta.name}`,
            description: `[EVOLVED SKILL] ${meta.description}`,
            parameters: meta.parameters
          });
        } catch (e) {
          debugLogger.error(`[DynamicToolRegistry] Failed to load skill meta: ${metaFile}`, e);
        }
      }
    } catch (e) {
      debugLogger.error('[DynamicToolRegistry] Directory scan failed', e);
    }
    return tools;
  }

  /**
   * Executes an evolved skill script.
   */
  public async runSkill(fullName: string, args: any): Promise<string> {
    const skillName = fullName.replace('run_evolved_skill_', '');
    const metaPath = path.join(this.skillsPath, `${skillName}.json`);
    
    if (!fs.existsSync(metaPath)) {
      throw new Error(`Skill ${skillName} not found.`);
    }

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as EvolvedSkillMetadata;
    const scriptPath = path.join(this.skillsPath, meta.executable);

    if (!fs.existsSync(scriptPath)) {
      throw new Error(`Executable for ${skillName} missing: ${meta.executable}`);
    }

    debugLogger.debug(`[DynamicToolRegistry] Executing ${skillName} with args:`, args);

    // Prepare execution command based on file extension
    let cmd = '';
    const ext = path.extname(scriptPath);
    const argsJson = JSON.stringify(args);

    if (ext === '.py') {
      cmd = `python3 "${scriptPath}" '${argsJson}'`;
    } else if (ext === '.sh') {
      cmd = `bash "${scriptPath}" '${argsJson}'`;
    } else if (ext === '.applescript' || ext === '.scpt') {
      cmd = `osascript "${scriptPath}" '${argsJson}'`;
    } else {
      throw new Error(`Unsupported executable type: ${ext}`);
    }

    try {
      const result = execSync(cmd, { encoding: 'utf8', stdio: 'pipe' });
      return result;
    } catch (err: any) {
      const errorMsg = err.stderr || err.message;
      debugLogger.error(`[DynamicToolRegistry] Skill execution failed: ${errorMsg}`);
      throw new Error(`Skill execution failed: ${errorMsg}`);
    }
  }
}
