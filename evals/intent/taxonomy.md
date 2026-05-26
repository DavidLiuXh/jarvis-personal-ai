# Intent Eval Taxonomy

This taxonomy keeps intent evals focused on stable behavioral invariants instead
of isolated bug examples. A case should declare one primary dimension and one
invariant id. Concrete prompts are evidence for the invariant, not the invariant
itself.

## Principles

These principles are the source of matrix invariants. New failures should be
mapped to one of these before adding a new rule or case.

- `SUBJECT_MEMORY_SEPARATION`: `external` requests must not receive personal
  memory; `personal` requests may use user memory or conversation history;
  `mixed` requests may combine personal memory and external knowledge.
- `MEMORY_TARGET_SPECIFICITY`: recall of saved user facts, older conversation,
  current conversation, and public past events are different targets and must not
  collapse into one generic recall bucket.
- `ACTION_DOMINANCE`: explicit execute, delegate, and schedule actions dominate
  generic chat/analyze labels, but false action cues such as "记得保存" must not
  become memory recall.
- `TOPIC_BOUNDARY_GROUNDING`: topic continuity must be grounded in recent
  conversation evidence; personal fact assertions and explicit older-artifact
  recall start a new topic boundary.
- `CURRENT_CONTEXT_LOCALITY`: current-context references are local to recent
  turns and should not pull long-term personal memory or facts.
- `TIME_SCOPED_RECALL_ISOLATION`: time-scoped conversation recall should search
  entry/session history for that range, not unrelated personal facts.
- `CLARIFICATION_BEFORE_RISKY_ACTION`: risky, destructive, under-specified, or
  schedule-create operations require clarification unless they are proactive
  tasks that already have their runtime schedule.
- `MULTI_STEP_PRESERVATION`: multi-intent requests must preserve step order and
  step type boundaries; current-context save operations are single execute
  actions, not artificial recall/analyze/execute chains.

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

## Semantic Axes

The generated semantic-space matrix covers combinations across these axes:

- `subject`: `external`, `personal`, `mixed`.
- `memoryTarget`: `none`, `user_memory`, `conversation_history`,
  `current_context_reference`, `external_past_event`.
- `action`: `chat`, `analyze`, `recall`, `execute`, `delegate`, `schedule`,
  plus multi-step composites.
- `topic`: `standalone`, `current_context_reference`, `older_history`,
  `time_scoped_history`, `new_topic`.
- `risk`: `low`, `medium`, `high`.

## Invariant Format

Each matrix case uses:

- `dimension`: primary eval dimension.
- `invariant`: stable uppercase id, for example
  `TIME_SCOPED_HISTORY_RECALL_USES_ENTRY_SCOPE`.
- `principles`: one or more principle ids from this document.
- `axes`: semantic-axis values used for coverage reporting.
- `tags`: optional search/filter metadata.
- `model`: deterministic raw model output overrides.
- `expect`: normalized `IntentFrame` and optional memory policy expectations.

When a production failure is found, add or update the invariant that failed. Add
a narrow case only when it represents a new semantic class.

## Current Invariant Catalog

- `EXTERNAL_SUBJECT_HAS_EMPTY_PERSONAL_MEMORY_CONTRACT`
- `EXTERNAL_PAST_EVENTS_ARE_NOT_PERSONAL_RECALL`
- `USER_MEMORY_RECALL_USES_USER_MEMORY_TARGET`
- `CONVERSATION_HISTORY_RECALL_USES_HISTORY_TARGET`
- `TIME_SCOPED_HISTORY_RECALL_USES_ENTRY_SCOPE`
- `REMEMBER_TO_ACTION_PHRASES_ARE_NOT_MEMORY_RECALL`
- `PERSONAL_FACT_ASSERTION_STARTS_NEW_TOPIC`
- `SELF_CONTAINED_ENTITY_QUERY_DOES_NOT_BORROW_CURRENT_CONTEXT`
- `EXPLICIT_HISTORY_ARTIFACT_RECALL_SHIFTS_TOPIC`
- `ANAPHORIC_FOLLOWUP_USES_CURRENT_CONTEXT_REFERENCE`
- `CURRENT_CONTEXT_SAVE_IS_SINGLE_EXECUTE_STEP`
- `LOCAL_WORKSPACE_ACTIONS_ARE_EXECUTE_AND_TOOL_BACKED`
- `EXPLICIT_AGENT_REQUESTS_ARE_DELEGATE`
- `INTERACTIVE_SCHEDULE_CREATE_REQUIRES_TIME`
- `PROACTIVE_TASKS_DO_NOT_ASK_SCHEDULE_TIME_CLARIFICATION`
- `SCHEDULE_DELETE_DOES_NOT_REQUIRE_NEW_TIME`
- `DESTRUCTIVE_MEMORY_OPERATIONS_REQUIRE_CONCRETE_TARGET`
- `RECALL_UPDATE_SCHEDULE_STAYS_ORCHESTRATED`
- `MULTI_INTENT_ORDER_PRESERVES_DELEGATE_THEN_SCHEDULE`
- `TECHNICAL_ACRONYMS_DO_NOT_ROUTE_TO_INVESTMENT_AGENT`

## Case Sources

- `matrix-cases.jsonl`: hand-authored regression cases derived from production
  failures but named by invariant.
- `semantic-space-cases.jsonl`: generated cases from the principle/axis matrix.
  Regenerate with `npm run intent:matrix:generate`.
