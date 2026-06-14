/**
 * Backend-aware smoke evals for the neutral LLM backend/tool-loop contract.
 *
 * These evals are intentionally offline. They validate provider adapters and
 * the shared ToolLoopRuntime contract without requiring live API credentials.
 */

import { ToolLoopRuntime } from "../packages/agent-runtime/src/llmBackend.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OpenAiChatCompletionsBackend,
  OpenAiPromptCompiler,
} from "../packages/agent-runtime/src/openAiBackend.js";
import type {
  LlmBackend,
  LlmEvent,
} from "../packages/agent-runtime/src/llmBackend.js";
import type {
  RuntimeToolRequest,
  RuntimeToolResult,
} from "../packages/intent-runtime/src/index.js";

type EvalCase = {
  name: string;
  suite: "standalone" | "compatibility";
  run: () => Promise<void>;
};

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function parseArgs(argv: string[]) {
  const args = {
    outputDir: path.join(repoRoot, "evals/logs"),
    updateLatest: true,
    suite: "all" as "all" | "standalone" | "compatibility",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--output-dir" && next) {
      args.outputDir = path.resolve(next);
      i += 1;
    } else if (arg === "--no-latest") {
      args.updateLatest = false;
    } else if (
      arg === "--suite" &&
      (next === "standalone" || next === "compatibility" || next === "all")
    ) {
      args.suite = next;
      i += 1;
    }
  }
  return args;
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function mockBackend(turns: LlmEvent[][]): LlmBackend {
  let index = 0;
  return {
    getModel: () => "mock",
    getCapabilities: () => ({
      streaming: true,
      nativeToolCalling: true,
      jsonMode: false,
      multimodalInput: false,
      maxContextTokens: 4096,
      modes: ["native_tool_calling"],
    }),
    async *sendTurn() {
      yield* turns[index++] ?? [];
    },
  };
}

function sse(...payloads: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const payload of payloads) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
        );
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

const cases: EvalCase[] = [
  {
    name: "gemini-compatible-prompt-compiler-tool-loop",
    suite: "compatibility",
    async run() {
      const { GeminiPromptCompiler } = await import(
        "../jarvis/src/core/geminiBackendAdapter.js"
      );
      const toolResults: RuntimeToolResult[] = [];
      const runtime = new ToolLoopRuntime({
        backend: mockBackend([
          [
            {
              type: "tool_call",
              request: {
                name: "task_add",
                callId: "call-1",
                args: { title: "review" },
              },
            },
          ],
          [{ type: "content", text: "done" }],
        ]),
        promptCompiler: new GeminiPromptCompiler(),
        toolExecutor: {
          executeTools: async (requests: RuntimeToolRequest[]) =>
            requests.map((request) => ({
              name: request.name,
              callId: request.callId,
              status: "success",
              output: { ok: true },
            })),
        },
        onToolResult: (result) => toolResults.push(result),
      });
      const result = await runtime.run({
        userPrompt: "schedule review",
        initialMessages: [
          { role: "user", blocks: [{ type: "text", text: "schedule review" }] },
        ],
        signal: new AbortController().signal,
      });
      assert(result.toolsCalled.has("task_add"), "task_add was not called");
      assert(toolResults[0]?.status === "success", "tool result failed");
    },
  },
  {
    name: "openai-compatible-streaming-tool-call",
    suite: "standalone",
    async run() {
      const backend = new OpenAiChatCompletionsBackend({
        apiKey: "test-key",
        model: "gpt-test",
        fetchFn: (async () =>
          new Response(
            sse({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call-1",
                        function: {
                          name: "task_add",
                          arguments: '{"title":"review"}',
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200 },
          )) as unknown as typeof fetch,
      });
      const events = [];
      for await (const event of backend.sendTurn(
        {
          messages: [
            {
              role: "user",
              blocks: [{ type: "text", text: "schedule review" }],
            },
          ],
          tools: [{ name: "task_add", parameters: { type: "object" } }],
        },
        new AbortController().signal,
      )) {
        events.push(event);
      }
      assert(events[0]?.type === "tool_call", "OpenAI tool call missing");
      assert(
        (events[0] as any).request.args.title === "review",
        "OpenAI tool args not reconstructed",
      );
      const compiled = new OpenAiPromptCompiler().compileToolResults(
        [
          {
            name: "task_add",
            callId: "call-1",
            status: "success",
            output: { ok: true },
          },
        ],
        [{ name: "task_add", callId: "call-1", args: { title: "review" } }],
      );
      assert(compiled[0]?.role === "assistant", "assistant tool call missing");
      assert(compiled[1]?.role === "tool", "tool result missing");
    },
  },
];

const args = parseArgs(process.argv.slice(2));
const selectedCases = cases.filter(
  (testCase) => args.suite === "all" || testCase.suite === args.suite,
);
const results: Array<{
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}> = [];
for (const testCase of selectedCases) {
  const startedAt = Date.now();
  try {
    await testCase.run();
    results.push({
      name: testCase.name,
      passed: true,
      durationMs: Date.now() - startedAt,
    });
    console.log(`PASS ${testCase.name}`);
  } catch (error) {
    results.push({
      name: testCase.name,
      passed: false,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    console.error(
      `FAIL ${testCase.name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const passed = results.filter((result) => result.passed).length;
const failed = results.length - passed;
const payload = {
  generatedAt: new Date().toISOString(),
  total: results.length,
  passed,
  failed,
  passRate: results.length === 0 ? 0 : passed / results.length,
  results,
};
const lines = [
  "# LLM Backend Eval Report",
  "",
  `- Result: ${passed}/${results.length}`,
  `- Pass rate: ${(payload.passRate * 100).toFixed(1)}%`,
  `- Generated: ${payload.generatedAt}`,
  "",
  "| Case | Result | Duration |",
  "| --- | --- | ---: |",
  ...results.map(
    (result) =>
      `| ${result.name} | ${result.passed ? "PASS" : "FAIL"} | ${result.durationMs}ms |`,
  ),
];
fs.mkdirSync(args.outputDir, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const jsonPath = path.join(args.outputDir, `llm-backend-${timestamp}.json`);
const mdPath = path.join(args.outputDir, `llm-backend-${timestamp}.md`);
fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2) + "\n");
fs.writeFileSync(mdPath, lines.join("\n") + "\n");
if (args.updateLatest) {
  fs.writeFileSync(
    path.join(args.outputDir, "llm-backend-latest.json"),
    JSON.stringify(payload, null, 2) + "\n",
  );
  fs.writeFileSync(
    path.join(args.outputDir, "llm-backend-latest.md"),
    lines.join("\n") + "\n",
  );
}
if (failed > 0) process.exit(1);
console.log(`Result: ${passed}/${results.length} passed`);
