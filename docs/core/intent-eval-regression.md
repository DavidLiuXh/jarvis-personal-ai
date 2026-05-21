# Intent Eval Regression

This document tracks the P0 work for making Jarvis intent understanding closer
to an industrial-grade system through real-model evals and repeatable
regression gates.

## Current Status

- Runner: `scripts/run_intent_evals.ts`
- Default cases: `evals/intent/cases.jsonl`
- Current coverage: 40+ cases
- Smoke suite: small high-signal gate tagged `suite:smoke`
- Core suite: stable regression gate tagged `suite:core`
- Extended suite: all non-candidate cases
- Stress suite: volatile/high-risk cases tagged `suite:stress`
- Primary eval model for now: `gemma4:e2b`

Covered dimensions:

- conversation recall vs external past events
- current conversation reference vs older conversation recall
- remember false positives
- chat/analyze/execute/schedule/delegate task types
- investment ticker routing vs technical acronym false positives
- mixed personal context plus external analysis
- multi-intent step extraction
- topic grounding and topic shift
- English and Chinese prompts

## Recommended Gates

Core gate:

```bash
npx tsx scripts/run_intent_evals.ts --models gemma4:e2b --suite core --min-pass-rate 1
```

Smoke gate:

```bash
npx tsx scripts/run_intent_evals.ts --models gemma4:e2b --suite smoke --min-pass-rate 1
```

Full gate:

```bash
npx tsx scripts/run_intent_evals.ts --models gemma4:e2b --suite extended --min-pass-rate 1
```

Volatility gate:

```bash
npx tsx scripts/run_intent_evals.ts --models gemma4:e2b --suite smoke --repeat 3 --min-pass-rate 1 --max-inconsistency-rate 0
```

Cross-model comparison:

```bash
npx tsx scripts/run_intent_evals.ts --models gemma4:e2b,Qwen2.5:1.5B-Instruct --suite smoke
```

Focused debugging:

```bash
npx tsx scripts/run_intent_evals.ts --models gemma4:e2b --tag recall
npx tsx scripts/run_intent_evals.ts --models gemma4:e2b --tag investment
npx tsx scripts/run_intent_evals.ts --models gemma4:e2b --tags technical-acronym,false-positive
```

## Runner Capabilities

The runner supports:

- `--suite <name>`: filters cases tagged `suite:<name>`
- Built-in suites:
  - `smoke`: small high-signal gate for quick local checks
  - `core`: stable regression set for mainline changes
  - `extended`: every non-candidate case
  - `stress`: volatile/high-risk scenarios for deeper checks
- `--tag <tag>`: filters one tag
- `--tags <a,b>`: filters cases containing any listed tag
- `--repeat <n>`: runs each selected case n times and reports signature stability
- `--min-pass-rate <0..1>`: fails the process if any model misses the minimum
- `--max-inconsistency-rate <0..1>`: fails when repeated runs exceed the allowed instability rate
- `--write-policy-baseline <path>`: writes exact policy trace path baselines
- `--compare-policy-baseline <path>`: fails when policy paths drift
- `--write-eval-candidates <path>`: writes failed cases as JSONL candidates
- `--list-suites`: prints built-in suite counts
- per-dimension and per-tag markdown summaries
- policy reason-code summaries grouped by category and severity
- confidence calibration summaries using pass/fail confidence distributions
- repeat consistency summaries when `--repeat` is enabled
- cross-model divergence summaries when multiple models are selected
- JSON reports for downstream tooling

## Suite Semantics

The suite split keeps local iteration fast without weakening regression quality:

- `smoke` is for quick checks after small intent changes. It covers recall,
  current context, schedule, personal fact grounding, and proactive
  clarification.
- `core` is the primary merge gate. It should stay stable enough to run often
  and strict enough to catch regressions in policy, memory boundary, task type,
  topic grounding, and multi-intent execution contract.
- `extended` is the broad local suite. It includes all reviewed cases except
  candidate queue entries.
- `stress` is for cases that are high-risk, historically flaky, or semantically
  dense. It is the preferred suite for `--repeat` volatility checks.

## Repeat Consistency

Use `--repeat N` to measure whether a case is merely passing once or actually
stable across repeated real-model calls. The runner groups repeated results by
case id and compares a compact signature containing:

- pass/fail value
- subject/task/memory/action dimensions
- candidate agents
- intent step summary
- topic relation
- applied policy reason codes
- clarification state and reasons

`--max-inconsistency-rate 0` is the strictest gate: any signature drift fails
the run. Use a higher threshold only for exploratory model comparison.

## Confidence Calibration

Every report now includes `confidenceCalibration` per model. For each
confidence dimension, the runner records pass samples, fail samples, pass P10,
pass average, fail max, and a suggested floor. This is not an automatic runtime
threshold change; it is an evidence table for replacing experience-based
thresholds with eval-backed thresholds after enough samples accumulate.

## Failure Candidate Loop

When any case fails, the runner writes JSONL candidates to:

```bash
evals/intent/candidates/intent-eval-candidates-latest.jsonl
```

Each candidate includes the original prompt, history, tags, failed checks,
run key, observed intent, clarification decision, and a draft `candidateCase`
skeleton. Use this file as the review queue for promoting real failures into
`evals/intent/cases.jsonl`.

## Next Industrialization Steps

This P0 expansion is still the start of the eval program. To get closer to
industrial quality, the next eval improvements should be:

- add real user query replay sets
- record nightly baselines and trend lines
- track repair rate, fallback rate, clarification rate, and topic conflict rate
- add failure taxonomy and root-cause labels
- add nightly jobs for `core`, `stress --repeat 3`, and cross-model smoke
- compare candidate local models against the same suite before model changes
