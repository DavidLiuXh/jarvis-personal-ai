# Intent Policy Layer

Jarvis intent understanding uses a local model for semantic judgment, then runs deterministic policies to make the result stable, explainable, and regression-testable.

## Goals

- Make guardrail priority explicit.
- Attach every deterministic correction to a reason code.
- Return a policy trace with before/after snapshots.
- Keep rule behavior covered by unit cases and intent eval cases.
- Run matrix regression after policy changes.

## Rule Model

Each policy rule is represented as an explicit unit:

- `id`: stable rule identifier, for example `subject.recall_cue_override`.
- `stage`: one of `normalize`, `guardrail`, `override`, `finalize`.
- `priority`: higher priority runs first within the current policy group.
- `reasonCode`: stable external-facing explanation code.
- `applies(state)`: deterministic predicate.
- `apply(state)`: deterministic state patch.
- `snapshot(state)`: compact before/after trace payload.

Rules live in `jarvis/src/core/intentPolicy.ts`. `intentResolver.ts` constructs policy state and calls the registry, but rule definitions and manifests are kept out of the resolver.

The registry is validated at construction time. Validation enforces non-empty rules, unique ids, unique reason codes, uppercase reason codes, group-prefixed rule ids, integer priorities, and no duplicate priority inside the same rule group. This keeps execution order explicit instead of relying on array position.

The resolver returns `IntentFrame.policyTrace`, where every applied rule includes:

- `ruleId`
- `stage`
- `priority`
- `reasonCode`
- `before`
- `after`

The policy runner also supports skipped-decision tracing for focused debugging via `recordSkipped`; normal resolver output keeps the trace to applied rules so runtime payloads stay compact.

Runtime stderr output is controlled by config:

```json
{
  "routing": {
    "intentPolicyObservability": true
  }
}
```

The trace is always available on `IntentFrame.policyTrace`; the switch only controls structured stderr logging in normal Jarvis runtime.

## Stages

`normalize`

Structural correction and deterministic extraction, such as action cue recovery, ticker normalization, and technical-term normalization.

`guardrail`

Semantic protection against known false positives, such as remember-to-action not being memory recall, external past events not being personal recall, and implicit delegate downgrade.

`override`

High-priority intent corrections, such as recall cue overriding subject/task type and schedule cue overriding task type.

`finalize`

Final enrichment, such as adding `investment-analysis` to `candidateAgents`.

## Current Rule Groups

Semantic evidence policies:

- `semantic.remember_to_action_not_recall`
- `semantic.anaphora_current_context`
- `semantic.conversation_history_from_none`
- `semantic.conversation_history_from_memory_or_stale_context`
- `semantic.action_cue_from_none`
- `semantic.investment_entity_normalization`
- `semantic.technical_entity_normalization`

Subject policies:

- `subject.recall_cue_override`
- `subject.recall_cue_mixed_external_context`
- `subject.personal_with_external_entity`
- `subject.external_personal_cue`
- `subject.low_confidence_external`

Task policies:

- `task.remember_to_action_not_recall`
- `task.schedule_cue_override`
- `task.external_past_event_not_recall`
- `task.recall_cue_override`
- `task.delegate_cue_override`
- `task.action_cue_execute`

Agent policies:

- `agent.investment_analysis_candidate`
- `agent.implicit_delegate_downgrade`

## Regression Commands

Run focused unit coverage:

```bash
npx vitest run jarvis/src/core/intentResolver.test.ts jarvis/src/core/conversationRecall.test.ts jarvis/src/core/intentAwareMemoryPolicy.test.ts --config jarvis/vitest.config.ts
```

Run the core real-model gate:

```bash
npx tsx scripts/run_intent_evals.ts --models gemma4:e2b --suite core --min-pass-rate 1
```

Run the full real-model gate:

```bash
npx tsx scripts/run_intent_evals.ts --models gemma4:e2b --min-pass-rate 1
```

Write a core policy trace baseline:

```bash
npx tsx scripts/run_intent_evals.ts --models gemma4:e2b --suite core --min-pass-rate 1 --write-policy-baseline evals/intent/policy-trace-baseline.core.json
```

Compare against the committed core policy trace baseline:

```bash
npx tsx scripts/run_intent_evals.ts --models gemma4:e2b --suite core --min-pass-rate 1 --compare-policy-baseline evals/intent/policy-trace-baseline.core.json
```

Policy changes should pass both unit coverage and the full real-model gate before commit.

## Eval Coverage

Intent eval cases can assert policy behavior:

- `expect.policyTrace.reasonCodesContain`
- `expect.policyTrace.reasonCodesNotContain`

The Markdown and JSON reports include `Policy Reason Codes`, showing how many cases and applications covered each reason code. This makes it visible when a rule has no regression coverage.

## Rule Coverage

Every registered policy rule must have a deterministic unit case in `jarvis/src/core/intentPolicy.test.ts`. This is intentionally separate from real-model evals because some policy paths depend on low-confidence or contradictory model output and should not rely on model luck for coverage.

The core real-model baseline is a path-stability gate: it detects when a case still passes but reaches the answer through a different policy trace.

The baseline comparison is exact for applied policy path: it compares `ruleId`, `stage`, `priority`, and `reasonCode`, and it fails on missing or unexpected cases. A passing eval with a different policy path is treated as a regression until the baseline is intentionally regenerated.
