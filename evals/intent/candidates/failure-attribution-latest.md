# Intent Failure Attribution Report

- Generated: 2026-05-26T08:06:56.713Z
- Attributions: 2

## By Category

| Name                 | Count |
| -------------------- | ----: |
| topic_boundary_error |     1 |
| memory_target_error  |     1 |

## By Principle

| Name                      | Count |
| ------------------------- | ----: |
| TOPIC_BOUNDARY_GROUNDING  |     1 |
| MEMORY_TARGET_SPECIFICITY |     1 |

## By Recommended Action

| Name                                 | Count |
| ------------------------------------ | ----: |
| add_expression_to_existing_invariant |     2 |

## Samples

### topic_grounding.self_contained_entity_not_current_context.gemma4_e2b

- Source: intent_eval_failure
- Category: topic_boundary_error
- Principle: TOPIC_BOUNDARY_GROUNDING
- Invariant: SELF_CONTAINED_ENTITY_QUERY_DOES_NOT_BORROW_CURRENT_CONTEXT
- Confidence: 0.85
- Recommended action: add_expression_to_existing_invariant
- Reason: topic boundary or recent-history check failed
- Prompt: Gemini Spark当前已经发布了？是否已经可用了？
- Failed checks:
  - topicShifted: expected false, actual true
  - topicAnalysis: expected ["same_topic","subtopic","adjacent_topic"], actual "new_topic"

### current_context.entity_overlap_keeps_current_context.gemma4_e2b

- Source: intent_eval_failure
- Category: memory_target_error
- Principle: MEMORY_TARGET_SPECIFICITY
- Invariant: ANAPHORIC_FOLLOWUP_USES_CURRENT_CONTEXT_REFERENCE
- Confidence: 0.90
- Recommended action: add_expression_to_existing_invariant
- Reason: memory target check failed
- Prompt: Gemini Spark当前已经可用了？
- Failed checks:
  - referencesRecentHistory: expected true, actual false
  - memoryTarget: expected "current_context_reference", actual "external_past_event"
  - topicAnalysis: expected "current_context_reference", actual "adjacent_topic"
