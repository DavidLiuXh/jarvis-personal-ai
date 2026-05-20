# Intent Eval Regression

This document tracks the P0 work for making Jarvis intent understanding closer
to an industrial-grade system through real-model evals and repeatable
regression gates.

## Current Status

- Runner: `scripts/run_intent_evals.ts`
- Default cases: `evals/intent/cases.jsonl`
- Current coverage: 39 cases
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
- per-dimension and per-tag markdown summaries
- JSON reports for downstream tooling

## Next Industrialization Steps

This P0 expansion is still the start of the eval program. To get closer to
industrial quality, the next eval improvements should be:

- add real user query replay sets
- record nightly baselines and trend lines
- track repair rate, fallback rate, clarification rate, and topic conflict rate
- add failure taxonomy and root-cause labels
- run selected suites multiple times to measure volatility
- compare candidate local models against the same suite before model changes
