# Runtime Package Semver Policy

This policy applies to:

- `@jarvis/memory-runtime`
- `@jarvis/intent-runtime`
- `@jarvis/agent-runtime`

The packages are currently `private: true`; this is an explicit decision to keep
distribution inside the repository until downstream consumers are ready. The
publish path is nevertheless treated as real: public exports point to `dist/*`,
examples avoid `jarvis/src/*`, and `npm pack --dry-run` is part of release
readiness.

## Public API

Public API is anything reachable from package `exports`:

- package root entrypoints, such as `@jarvis/agent-runtime`;
- documented subpaths, such as `@jarvis/memory-runtime/retrieval`;
- exported types and classes from those entrypoints.

Internal API is anything under `src/*` that is not in `exports`. External
projects must not import internal files directly.

## Versioning Rules

Major version changes:

- remove or rename exported types, classes, methods, fields, or subpaths;
- change `IntentFrame`, `MemoryContract`, `IntentExecutionPlan`,
  `RuntimeContext`, or LLM backend schemas in a source-incompatible way;
- change policy behavior in a way that can alter subject boundaries, memory
  leakage guarantees, clarification blocking, or tool execution obligations;
- change adapter contracts for resolver, memory store, tool executor, agent
  executor, skill runtime, response composer, LLM backend, or prompt compiler;
- change required eval invariants or quality gates in a way that downstream
  projects must satisfy differently.

Minor version changes:

- add optional fields to schemas;
- add new reason codes, policy trace metadata, runtime events, or diagnostics;
- add optional adapter hooks;
- add new package subpath exports;
- add new quality dashboard metrics without changing gate semantics.

Patch version changes:

- bug fixes that preserve public types and documented behavior;
- stricter internal validation that does not change accepted valid inputs;
- documentation, examples, and packaging fixes;
- eval case additions that do not change required gates.

## Release Checklist

Before a package can be published outside Jarvis:

1. `npm run runtime:build` succeeds.
2. `npm run runtime:pack:dry-run` shows only expected package artifacts.
3. `npm run runtime:quality` succeeds.
4. Public examples run without importing `jarvis/src/*`.
5. Roadmap maturity and package READMEs describe the current support level.
