/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { AgentCard, AgentTask } from "./externalAgent.js";
import crypto from "node:crypto";

/** How long to wait for the agent process to become ready (ms) */
const READY_TIMEOUT_MS = 30_000;
/** How often to poll the health endpoint while waiting (ms) */
const READY_POLL_INTERVAL_MS = 500;
/** HTTP read timeout for A2A streaming calls (ms) */
const STREAM_TIMEOUT_MS = 600_000; // Increased to 10 minutes for deep analysis

// ── Port allocation ──────────────────────────────────────────────────────────

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on("error", reject);
  });
}

// ── Process health check ─────────────────────────────────────────────────────

async function waitForReady(
  port: number,
  isExited: () => boolean,
): Promise<boolean> {
  const url = `http://127.0.0.1:${port}/.well-known/agent-card.json`;
  const deadline = Date.now() + READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (isExited()) return false;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // polling
    }
    await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
  }
  return false;
}

// ── A2A event helpers ─────────────────────────────────────────────────────────

function normalizeState(raw: string): string {
  return raw.toLowerCase().replace(/_/g, "-");
}

function buildA2AMessage(text: string): any {
  return {
    role: "ROLE_USER",
    parts: [{ text }],
    message_id: crypto.randomUUID(),
  };
}

// ── Streaming SSE parser ─────────────────────────────────────────────────────

async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buf = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          yield JSON.parse(payload);
        } catch {
          // malformed SSE
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Main launcher ────────────────────────────────────────────────────────────

export type LaunchCallbacks = {
  onChunk: (chunk: string) => void;
  onComplete: (output: string) => void;
  onFailed: (error: string) => void;
  onInputRequired: (question: string, contextId: string) => void;
  onLog?: (line: string) => void;
};

export async function launchAgent(
  card: AgentCard,
  task: AgentTask,
  callbacks: LaunchCallbacks,
): Promise<{ pid: number; port: number } | null> {
  let child: ChildProcess | null = null;
  let port = 0;

  try {
    port = await findFreePort();
    child = spawn("python3", [card.entrypoint], {
      env: {
        ...process.env,
        JARVIS_AGENT_PORT: String(port),
        JARVIS_AGENT_ID: card.agentId,
        JARVIS_TASK_ID: task.taskId,
        JARVIS_SESSION_ID: task.sessionId,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const pid = child.pid!;
    const logLine = (line: string) => {
      console.error(`[Agent:${card.agentId}:${pid}] ${line}`);
      callbacks.onLog?.(line);
    };
    child.stdout?.on("data", (d: Buffer) =>
      d.toString().split("\n").filter(Boolean).forEach(logLine),
    );
    child.stderr?.on("data", (d: Buffer) =>
      d.toString().split("\n").filter(Boolean).forEach(logLine),
    );

    let processExited = false;
    const exitPromise = new Promise<number | null>((resolve) => {
      child!.on("exit", (code) => {
        processExited = true;
        resolve(code);
      });
    });

    const ready = await waitForReady(port, () => processExited);
    if (!ready || processExited) {
      callbacks.onFailed("Agent failed to start or become ready.");
      child.kill();
      return null;
    }

    const rpcBody = JSON.stringify({
      jsonrpc: "2.0",
      id: task.taskId,
      method: "SendStreamingMessage",
      params: {
        message: buildA2AMessage(JSON.stringify(task.input)),
        configuration: { acceptedOutputModes: ["text/plain"] },
      },
    });

    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "A2A-Version": "1.0",
      },
      body: rpcBody,
      signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
    });

    if (!response.ok || !response.body) {
      callbacks.onFailed(`A2A failed: HTTP ${response.status}`);
      child.kill();
      return null;
    }

    let finalOutput = "";
    for await (const event of parseSSE(response.body)) {
      const e = event as any;
      const res = e?.result ?? {};

      // ── Handle Content (Artifacts) ────────────────────────────────────────
      // Support both legacy "artifact" and modern "artifactUpdate"
      const artifact = res.artifactUpdate?.artifact ?? res.artifact;
      if (artifact?.parts) {
        for (const p of artifact.parts) {
          if (p.text) {
            callbacks.onChunk(p.text);
            finalOutput += p.text;
          }
        }
      }

      // ── Handle Status ─────────────────────────────────────────────────────
      // Support both legacy "status" and modern "statusUpdate"
      const statusUpdate = res.statusUpdate?.status ?? res.status;
      if (statusUpdate) {
        const state = normalizeState(statusUpdate.state ?? "");
        if (state === "input-required") {
          const question =
            statusUpdate.message?.parts?.find((p: any) => p.text)?.text ??
            "Input required";
          callbacks.onInputRequired(
            question,
            res.statusUpdate?.contextId || task.taskId,
          );
          return { pid, port };
        }
        if (state === "completed" || state === "task-state-completed") {
          // Found a completion event, but we'll continue the loop to drain
          // any remaining data chunks.
          continue;
        }
        if (state === "failed" || state === "task-state-failed") {
          callbacks.onFailed(
            statusUpdate.message?.parts?.[0]?.text ?? "Task failed",
          );
          child.kill();
          return null;
        }
      }
    }

    callbacks.onComplete(finalOutput || "(no output)");
    const code = await Promise.race([
      exitPromise,
      new Promise((r) => setTimeout(() => r(null), 2000)),
    ]);
    if (code === null) child.kill("SIGKILL");

    return { pid, port };
  } catch (err: any) {
    callbacks.onFailed(err.message);
    child?.kill();
    return null;
  }
}

export async function sendAgentInput(
  port: number,
  taskId: string,
  contextId: string,
  value: string,
  callbacks: LaunchCallbacks,
): Promise<void> {
  const rpcBody = JSON.stringify({
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "SendStreamingMessage",
    params: {
      message: {
        ...buildA2AMessage(value),
        task_id: taskId,
        context_id: contextId,
      },
      configuration: { acceptedOutputModes: ["text/plain"] },
    },
  });

  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "A2A-Version": "1.0",
      },
      body: rpcBody,
      signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
    });

    if (!response.ok || !response.body) {
      callbacks.onFailed(`A2A resume failed: HTTP ${response.status}`);
      return;
    }

    let finalOutput = "";
    for await (const event of parseSSE(response.body)) {
      const e = event as any;
      const res = e?.result ?? {};

      const artifact = res.artifactUpdate?.artifact ?? res.artifact;
      if (artifact?.parts) {
        for (const p of artifact.parts) {
          if (p.text) {
            callbacks.onChunk(p.text);
            finalOutput += p.text;
          }
        }
      }

      const statusUpdate = res.statusUpdate?.status ?? res.status;
      if (statusUpdate?.state) {
        const state = normalizeState(statusUpdate.state);
        if (state === "completed" || state === "task-state-completed") break;
        if (state === "input-required") {
          const q =
            statusUpdate.message?.parts?.find((p: any) => p.text)?.text ??
            "Input needed";
          callbacks.onInputRequired(
            q,
            res.statusUpdate?.contextId || contextId,
          );
          return;
        }
      }
    }
    callbacks.onComplete(finalOutput || "(no output)");
  } catch (err: any) {
    callbacks.onFailed(err.message);
  }
}
