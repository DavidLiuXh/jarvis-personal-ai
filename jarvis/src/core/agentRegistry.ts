/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from "fs";
import path from "path";
import os from "os";
import type { AgentCard } from "./externalAgent.js";

/**
 * Directories scanned for agent.json files, in priority order.
 * Later directories can override agents with the same agentId.
 *
 *  1. ~/.gemini-jarvis/agents/   — user-global agents (not in version control)
 *  2. <cwd>/.gemini/agents/      — project-local agents (committed to repo)
 */
function getAgentsDirs(cwd: string): string[] {
  return [
    path.join(os.homedir(), ".gemini-jarvis", "agents"),
    path.join(cwd, ".gemini", "agents"),
  ];
}

/**
 * Scans agent directories for agent.json files and returns validated
 * AgentCard objects. Silently skips malformed entries.
 * Project-local agents (cwd/.gemini/agents/) take precedence over
 * user-global ones when agentIds collide.
 */
export function loadAgentRegistry(cwd: string = process.cwd()): AgentCard[] {
  const seen = new Map<string, AgentCard>();

  for (const agentsDir of getAgentsDirs(cwd)) {
    if (!fs.existsSync(agentsDir)) continue;

    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cardPath = path.join(agentsDir, entry.name, "agent.json");
      if (!fs.existsSync(cardPath)) continue;

      try {
        const raw = JSON.parse(
          fs.readFileSync(cardPath, "utf8"),
        ) as Partial<AgentCard>;

        if (!raw.agentId || !raw.name || !raw.entrypoint) {
          console.error(
            `⚠️ [AgentRegistry] Skipping ${entry.name}: missing required fields (agentId, name, entrypoint)`,
          );
          continue;
        }

        // Resolve entrypoint relative to the agent's own directory
        const entrypoint = path.isAbsolute(raw.entrypoint)
          ? raw.entrypoint
          : path.join(agentsDir, entry.name, raw.entrypoint);

        if (!fs.existsSync(entrypoint)) {
          console.error(
            `⚠️ [AgentRegistry] Skipping ${entry.name}: entrypoint not found: ${entrypoint}`,
          );
          continue;
        }

        // triggers field is informational only (used by !agent list hints)
        // Trigger-based auto-routing was removed; explicit "agent:" prefix is now required
        const triggers = Array.isArray(raw.triggers) ? raw.triggers : [];
        if (triggers.length === 0) {
          console.error(
            `ℹ️ [AgentRegistry] Agent ${raw.agentId} has no triggers defined`,
          );
        }

        seen.set(raw.agentId, {
          agentId: raw.agentId,
          name: raw.name,
          description: raw.description ?? "",
          entrypoint,
          inputSchema: raw.inputSchema ?? {},
          estimatedDuration: raw.estimatedDuration ?? "unknown",
          triggers,
        });
      } catch (e: any) {
        console.error(
          `⚠️ [AgentRegistry] Failed to parse ${cardPath}: ${e.message}`,
        );
      }
    }
  }

  const cards = Array.from(seen.values());
  if (cards.length > 0) {
    console.error(
      `🤖 [AgentRegistry] Loaded ${cards.length} agent(s): ${cards.map((c) => c.agentId).join(", ")}`,
    );
  }

  return cards;
}
