# Intent Eval Taxonomy

This taxonomy keeps intent evals focused on stable behavioral invariants instead
of isolated bug examples. A case should declare one primary dimension and one
invariant id. Concrete prompts are evidence for the invariant, not the invariant
itself.

## Dimensions

- `memoryTarget`: classifies whether a request needs long-term user memory,
  conversation history, current context, an external past event, or no memory.
- `topicBoundary`: verifies topic shift and recent-history continuity decisions.
- `actionBoundary`: separates chat, recall, execute, delegate, and schedule
  actions.
- `multiIntent`: verifies step extraction, ordering, and execution boundaries.
- `memoryPolicy`: verifies the Memory Contract generated from intent.
- `agentRouting`: verifies candidate agent decisions and false-positive guards.
- `clarification`: verifies whether Jarvis should ask before acting.

## Invariant Format

Each matrix case uses:

- `dimension`: primary eval dimension.
- `invariant`: stable uppercase id, for example
  `TIME_SCOPED_HISTORY_RECALL_USES_ENTRY_SCOPE`.
- `tags`: optional search/filter metadata.
- `model`: deterministic raw model output overrides.
- `expect`: normalized `IntentFrame` and optional memory policy expectations.

When a production failure is found, add or update the invariant that failed. Add
a narrow case only when it represents a new semantic class.
