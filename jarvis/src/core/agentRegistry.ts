/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from "fs";
import path from "path";
import os from "os";
import type { AgentCard } from "./externalAgent.js";

const AGENTS_DIR = path.join(os.homedir(), ".gemini-jarvis", "agents");

/**
 * Scans ~/.gemini-jarvis/agents/ for agent.json files and returns
 * validated AgentCard objects. Silently skips malformed entries.
 */
export function loadAgentRegistry(): AgentCard[] {
  if (!fs.existsSync(AGENTS_DIR)) return [];

  const cards: AgentCard[] = [];

  for (const entry of fs.readdirSync(AGENTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cardPath = path.join(AGENTS_DIR, entry.name, "agent.json");
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
        : path.join(AGENTS_DIR, entry.name, raw.entrypoint);

      if (!fs.existsSync(entrypoint)) {
        console.error(
          `⚠️ [AgentRegistry] Skipping ${entry.name}: entrypoint not found: ${entrypoint}`,
        );
        continue;
      }

      // Warn if triggers is empty — agent will never auto-route
      const triggers = Array.isArray(raw.triggers) ? raw.triggers : [];
      if (triggers.length === 0) {
        console.error(
          `⚠️ [AgentRegistry] Agent ${raw.agentId} has no triggers — it will never be auto-routed`,
        );
      }

      cards.push({
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

  if (cards.length > 0) {
    console.error(
      `🤖 [AgentRegistry] Loaded ${cards.length} agent(s): ${cards.map((c) => c.agentId).join(", ")}`,
    );
  }

  return cards;
}
