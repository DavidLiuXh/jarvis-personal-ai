# Intent Eval Regression

This document tracks the P0 work for making Jarvis intent understanding closer
to an industrial-grade system through real-model evals and repeatable
regression gates.

## Current Status

- Runner: `scripts/run_intent_evals.ts`
- Default cases: `evals/intent/cases.jsonl`
- Current coverage: 40 cases
- Core suite: cases tagged `suite:core`
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

Full gate:

```bash
npx tsx scripts/run_intent_evals.ts --models gemma4:e2b --min-pass-rate 1
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
- `--tag <tag>`: filters one tag
- `--tags <a,b>`: filters cases containing any listed tag
- `--min-pass-rate <0..1>`: fails the process if any model misses the minimum
- `--write-policy-baseline <path>`: writes exact policy trace path baselines
- `--compare-policy-baseline <path>`: fails when policy paths drift
- `--write-eval-candidates <path>`: writes failed cases as JSONL candidates
- per-dimension and per-tag markdown summaries
- policy reason-code summaries grouped by category and severity
- confidence calibration summaries using pass/fail confidence distributions
- JSON reports for downstream tooling

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
observed intent, clarification decision, and a draft `candidateCase` skeleton.
Use this file as the review queue for promoting real failures into
`evals/intent/cases.jsonl`.

## Next Industrialization Steps

This P0 expansion is still the start of the eval program. To get closer to
industrial quality, the next eval improvements should be:

- add real user query replay sets
- record nightly baselines and trend lines
- track repair rate, fallback rate, clarification rate, and topic conflict rate
- add failure taxonomy and root-cause labels
- run selected suites multiple times to measure volatility
- compare candidate local models against the same suite before model changes
