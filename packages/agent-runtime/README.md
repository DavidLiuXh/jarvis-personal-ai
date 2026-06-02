# @jarvis/agent-runtime

Backend-neutral agent runtime facade for projects that want Jarvis-style
intent, memory, skill, execution, response composition, and LLM tool-loop
orchestration without importing Jarvis core.

## Public API

Use the package entrypoint for stable imports:

```ts
import {
  AgentRuntime,
  ToolLoopRuntime,
  OpenAiChatBackend,
  OpenAiPromptCompiler,
} from "@jarvis/agent-runtime";
```

The public surface is intentionally adapter-oriented:

- `AgentRuntime` owns the turn lifecycle.
- `RuntimeContext` carries intent, memory, skills, execution, response, and LLM
  loop state.
- `SkillRuntime` and `ResponseComposer` let hosts inject project-specific
  behavior without changing the runtime.
- `LlmBackend`, `PromptCompiler`, and `ToolLoopRuntime` decouple the runtime
  from Gemini CLI or OpenAI-compatible protocols.

Do not import from `src/*` in external projects. Subpath exports point to
`dist/*` after `npm run runtime:build`.

## Package Boundary

`@jarvis/agent-runtime` may depend on `@jarvis/intent-runtime` and
`@jarvis/memory-runtime`. It must not import `jarvis/src/core/*`.

Jarvis-specific channels, scheduler, ToolRouter, Gemini compatibility adapter,
and persistence remain application adapters outside this package.
