/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { AgentCard, AgentTask } from "./externalAgent.js";

/** How long to wait for the agent process to become ready (ms) */
const READY_TIMEOUT_MS = 30_000;
/** How often to poll the health endpoint while waiting (ms) */
const READY_POLL_INTERVAL_MS = 500;
/** HTTP read timeout for A2A streaming calls (ms) */
const STREAM_TIMEOUT_MS = 300_000; // 5 minutes

// ── Port allocation ──────────────────────────────────────────────────────────

/** Finds a free TCP port on localhost. */
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

/**
 * Polls the agent's /.well-known/agent.json endpoint until it returns 200
 * or the timeout expires. Returns true when ready.
 */
async function waitForReady(port: number): Promise<boolean> {
  const url = `http://127.0.0.1:${port}/.well-known/agent-card.json`;
  const deadline = Date.now() + READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // process not yet listening — wait and retry
    }
    await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
  }
  return false;
}

// ── A2A JSON-RPC helpers ─────────────────────────────────────────────────────

type A2ATextPart = { kind: "text"; text: string };
type A2AMessage = {
  role: "user";
  parts: A2ATextPart[];
  messageId: string;
};

function buildA2AMessage(text: string): A2AMessage {
  return {
    role: "user",
    parts: [{ kind: "text", text }],
    messageId: crypto.randomUUID(),
  };
}

// ── Streaming SSE parser ─────────────────────────────────────────────────────

/** Yields parsed JSON objects from an SSE stream body. */
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
          // malformed SSE chunk — skip
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
  onInputRequired: (question: string) => void;
};

/**
 * Spawns an ADK agent process, waits until it is ready, sends the task via
 * A2A streaming, relays chunks back through callbacks, then kills the process.
 */
export async function launchAgent(
  card: AgentCard,
  task: AgentTask,
  callbacks: LaunchCallbacks,
): Promise<{ pid: number; port: number } | null> {
  const port = await findFreePort();
  let child: ChildProcess | null = null;

  try {
    // ── 1. Spawn Python process ──────────────────────────────────────────────
    child = spawn("python3", [card.entrypoint], {
      env: {
        ...process.env,
        JARVIS_AGENT_PORT: String(port),
        JARVIS_AGENT_ID: card.agentId,
        JARVIS_TASK_ID: task.taskId,
        JARVIS_SESSION_ID: task.sessionId,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    const pid = child.pid!;

    child.stdout?.on("data", (d: Buffer) => {
      console.error(
        `[Agent:${card.agentId}:${pid}] stdout: ${d.toString().trim()}`,
      );
    });
    child.stderr?.on("data", (d: Buffer) => {
      console.error(
        `[Agent:${card.agentId}:${pid}] stderr: ${d.toString().trim()}`,
      );
    });

    let processExited = false;
    const exitPromise = new Promise<number | null>((resolve) => {
      child!.on("exit", (code) => {
        processExited = true;
        resolve(code);
      });
    });

    console.error(
      `🚀 [AgentLauncher] Spawned ${card.agentId} (pid=${pid}, port=${port})`,
    );

    // ── 2. Wait for agent to be ready ────────────────────────────────────────
    const ready = await waitForReady(port);
    if (!ready || processExited) {
      const msg = processExited
        ? `Agent process exited before becoming ready`
        : `Agent did not become ready within ${READY_TIMEOUT_MS}ms`;
      callbacks.onFailed(msg);
      child.kill();
      return null;
    }

    console.error(
      `✅ [AgentLauncher] Agent ${card.agentId} ready on port ${port}`,
    );

    // ── 3. Build A2A request payload ─────────────────────────────────────────
    // Serialize task input as a human-readable text message
    const inputText = JSON.stringify(task.input, null, 2);
    const a2aMessage = buildA2AMessage(inputText);

    const rpcBody = JSON.stringify({
      jsonrpc: "2.0",
      id: task.taskId,
      method: "message/stream",
      params: {
        message: a2aMessage,
        configuration: { acceptedOutputModes: ["text/plain"] },
      },
    });

    // ── 4. Call agent via A2A streaming ──────────────────────────────────────
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: rpcBody,
      signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
    });

    if (!response.ok || !response.body) {
      callbacks.onFailed(`A2A call failed: HTTP ${response.status}`);
      child.kill();
      return null;
    }

    // ── 5. Stream SSE events ─────────────────────────────────────────────────
    let finalOutput = "";
    let taskCompleted = false;

    for await (const event of parseSSE(response.body)) {
      const e = event as any;

      // TaskArtifactUpdateEvent — streaming text chunk
      if (e?.result?.artifact) {
        const parts: any[] = e.result.artifact.parts ?? [];
        for (const part of parts) {
          if (part.kind === "text" && part.text) {
            callbacks.onChunk(part.text);
            finalOutput += part.text;
          }
        }
        continue;
      }

      // TaskStatusUpdateEvent
      if (e?.result?.status) {
        const state: string = e.result.status.state ?? "";

        if (state === "input-required" || state === "INPUT_REQUIRED") {
          // Extract question from message parts if present
          const msgParts: any[] = e.result.status.message?.parts ?? [];
          const question =
            msgParts.find((p: any) => p.kind === "text")?.text ??
            "Agent requires additional input.";
          callbacks.onInputRequired(question);
          // Don't kill process — it stays alive awaiting sendInput
          return { pid, port };
        }

        if (state === "completed" || state === "COMPLETED") {
          taskCompleted = true;
          continue;
        }

        if (state === "failed" || state === "FAILED") {
          const errMsg =
            e.result.status.message?.parts?.find((p: any) => p.kind === "text")
              ?.text ?? "Agent task failed";
          callbacks.onFailed(errMsg);
          child.kill();
          return null;
        }
      }

      // Top-level Message result (non-streaming fallback)
      if (e?.result?.parts) {
        const parts: any[] = e.result.parts;
        for (const part of parts) {
          if (part.kind === "text" && part.text) {
            finalOutput += part.text;
          }
        }
        taskCompleted = true;
      }
    }

    // ── 6. Finalize ──────────────────────────────────────────────────────────
    if (!taskCompleted && !finalOutput) {
      // Stream ended without a clear completion event — use what we got
      console.error(
        `⚠️ [AgentLauncher] Stream ended without explicit completion for task ${task.taskId}`,
      );
    }

    callbacks.onComplete(finalOutput || "(no output)");

    // Wait for process to exit cleanly, then kill if it doesn't
    const exitCode = await Promise.race([
      exitPromise,
      new Promise<null>((r) => setTimeout(() => r(null), 5000)),
    ]);
    if (exitCode === null) {
      console.error(
        `⚠️ [AgentLauncher] Agent did not exit within 5s, force-killing (pid=${pid})`,
      );
      child.kill("SIGKILL");
    }

    return { pid, port };
  } catch (err: any) {
    callbacks.onFailed(`Launcher error: ${err.message}`);
    child?.kill();
    return null;
  }
}

/**
 * Sends user input to an already-running agent task (INPUT_REQUIRED state).
 * Resumes the stream and relays remaining output through callbacks.
 */
export async function sendAgentInput(
  port: number,
  taskId: string,
  contextId: string,
  value: string,
  callbacks: LaunchCallbacks,
): Promise<void> {
  const a2aMessage = buildA2AMessage(value);
  const rpcBody = JSON.stringify({
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "message/stream",
    params: {
      message: { ...a2aMessage, taskId, contextId },
      configuration: { acceptedOutputModes: ["text/plain"] },
    },
  });

  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
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
      if (e?.result?.artifact) {
        for (const part of e.result.artifact.parts ?? []) {
          if (part.kind === "text" && part.text) {
            callbacks.onChunk(part.text);
            finalOutput += part.text;
          }
        }
      }
      if (e?.result?.status?.state === "completed") {
        break;
      }
    }
    callbacks.onComplete(finalOutput || "(no output)");
  } catch (err: any) {
    callbacks.onFailed(`sendAgentInput error: ${err.message}`);
  }
}
