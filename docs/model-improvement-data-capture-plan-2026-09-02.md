# Model Improvement Data Capture Plan

Date: 2026-09-02

## Context

FlowJo import/export supports interoperability and expert-gate evaluation. Model improvement
needs a separate data contract: capture enough context around AI gate proposals and user
corrections to replay, compare, and improve agent behavior later.

The goal is not to ask experts for routine explanations. The product should collect useful
training and evaluation signals from normal correction workflows, then ask experts targeted
questions only for hard or repeated failures.

## Goals

- Capture AI gate proposals and expert corrections as replayable examples.
- Preserve the visible plot context that shaped the agent decision.
- Support automatic quality metrics against expert gates or corrected gates.
- Enable prompt/model regression tests by replaying old decisions with new instructions.
- Keep expert burden low by preferring correction deltas and pairwise ranking over free text.

## Non-Goals

- Do not fine-tune models in this PR sequence.
- Do not store PHI or patient identifiers in model-improvement artifacts.
- Do not require experts to annotate every correction with written rationale.
- Do not make FlowJo `.wsp` the canonical state; `flowcyto.workspace.json` remains canonical.

## Captured Event Types

### AI Gate Proposal

Capture whenever an agent proposes or writes a gate:

```json
{
  "eventType": "ai_gate_proposal",
  "workspaceRevision": 3,
  "sampleId": "sample_001",
  "parentGateId": "root",
  "gate": { "id": "ai_main_population", "type": "polygon" },
  "plotContextRef": "plot-context/...",
  "agent": {
    "host": "codex",
    "model": "cheap-or-production-model-id",
    "promptHash": "sha256..."
  }
}
```

### User Gate Correction

Capture whenever a user edits a gate originally written by an agent:

```json
{
  "eventType": "user_gate_correction",
  "workspaceRevisionBefore": 3,
  "workspaceRevisionAfter": 4,
  "sampleId": "sample_001",
  "parentGateId": "root",
  "beforeGate": { "id": "ai_main_population", "type": "polygon" },
  "afterGate": { "id": "ai_main_population", "type": "polygon" },
  "plotContextRef": "plot-context/..."
}
```

### Expert Preference

For selected low-confidence or low-agreement cases, ask a lightweight ranking question:

```json
{
  "eventType": "expert_gate_preference",
  "sampleId": "sample_001",
  "parentGateId": "root",
  "candidateGateIds": ["gate_a", "gate_b"],
  "preferredGateId": "gate_b",
  "reasonCode": "optional_short_code"
}
```

Use pairwise preference before free-text explanation. Written rationale is reserved for recurring
failure modes or biologically important disagreements.

## Replayable Plot Context

Each proposal/correction should reference a frozen plot context containing:

- Sample id and workspace revision.
- Parent population id and active gate ancestry.
- Axis names, bounds, scale, transform, and tick policy.
- Render mode and visible preview data: bins or sampled points.
- Compensation state: no compensation, compensation id, matrix hash, and aligned channels.
- Gate hierarchy visible to the agent.
- Any geometry instructions or few-shot examples used by the agent.

This context lets us replay the same decision later with updated prompts or models.

## Metrics

Compare gates in event space, not coordinate space:

- Jaccard: `|AI_events intersect reference_events| / |AI_events union reference_events|`.
- Precision: fraction of AI-included events also included by the reference gate.
- Recall: fraction of reference-included events captured by the AI gate.
- Delta area and centroid shift as secondary diagnostics only.

Recommended thresholds:

- Main FSC/SSC gates: Jaccard above 0.90 is usually acceptable.
- Fluorescence marker gates: threshold depends on biology and population rarity; use expert
  review for low-frequency or ambiguous populations.
- Below 0.80: queue for targeted failure review.

## Storage

Start with local JSONL artifacts beside the workspace:

```text
flowcyto.workspace.json
.datalox/
  model-improvement/
    plot-contexts/
      <context_id>.json
    gate-events.jsonl
```

The local artifact should be deterministic and inspectable. Upload/sync can be a later product
layer after privacy and consent rules are explicit.

## Privacy Boundary

- Store file hashes and sample ids, not patient names.
- Do not copy raw FCS events into shared training data by default.
- Treat plot bins/sampled points as potentially sensitive derived data.
- Add an explicit export step before any artifact leaves the user's machine.

## PR Sequence

### PR C1: Local Correction Log

Branch: `feat/flowcyto-gate-correction-log`

- Add a local append-only JSONL correction log.
- Log AI proposal metadata from agent-written `upsert_gate` calls when provenance is supplied.
- Log before/after gate deltas for user edits in the gate editor.
- Add tests for deterministic event shape and revision linkage.

### PR C2: Replay Context Snapshots

Branch: `feat/flowcyto-plot-context-replay`

- Add `capture_plot_context` internal helper using the same path as `get_plot_context`.
- Persist frozen context JSON files and reference them from gate events.
- Include compensation id, scale, bounds, parent population, bins/points, and gate hierarchy.
- Add replay tests that reconstruct the same render context.

### PR C3: Gate Agreement Metrics

Branch: `feat/flowcyto-gate-agreement-metrics`

- Add event-membership comparison for two gates or gate sets.
- Add Jaccard, precision, recall, and event counts.
- Support imported FlowJo gates once FlowJo import lands.
- Add MCP tool: `compare_gate_membership`.

### PR C4: Targeted Expert Review Queue

Branch: `feat/flowcyto-expert-review-queue`

- Create local review items for low-Jaccard or high-impact disagreements.
- Support pairwise preference records.
- Keep free-text explanations optional and targeted.

## Relationship to FlowJo Import

FlowJo import provides expert reference gates. This plan defines how Flowcyto captures and
replays AI/user gating decisions. The two tracks are complementary but should remain separate:

- FlowJo import/export: compatibility and ground-truth ingestion.
- Model-improvement capture: replayable correction data and preference signals.
