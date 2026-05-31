# @jarvis/intent-runtime

Reusable intent execution primitives extracted from Jarvis.

## Boundary

This package owns:

- intent execution plan construction;
- step runtime state;
- required-tool enforcement helpers;
- duplicate/dependent tool-call suppression.

It may depend on `@jarvis/memory-runtime` schema and CRUD policy primitives. It
must not import from `jarvis/src/core`.

## Minimal Usage

```ts
import { IntentStepRuntime } from "@jarvis/intent-runtime";
import type { IntentFrame } from "@jarvis/memory-runtime";

const runtime = new IntentStepRuntime(intentFrame as IntentFrame);
const missingPrompt = runtime.buildMissingStepPrompt();
const deterministicRequests = runtime.buildDeterministicToolRequests();
```

## Compatibility

Jarvis still exposes compatibility re-exports under `jarvis/src/intent-runtime/*`.
New runtime code should import from `packages/intent-runtime/src/*` or the package
entrypoint.
