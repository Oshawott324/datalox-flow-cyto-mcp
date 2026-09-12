# Apoptosis Gating Implementation Plan

Date: 2026-09-11

## Goal

Add an agent-explicit apoptosis gating workflow to Flowcyto MCP for common
Annexin V / membrane-death dye assays.

The tool should help an agent propose and summarize apoptosis quadrant gates,
while keeping the scientific contract explicit:

- Do not infer biology from filenames alone.
- Do not write gates unless the user asks.
- Do not silently apply compensation.
- Do not hard-code one lab's channels, sample names, or control layout.

## Local Validation Dataset

Use this folder for live validation, not as committed fixture data:

```text
C:\Users\fangxf\Research Tools\Flow data\7_Apoptosis_cwq
```

Observed files:

| File | Intended role for validation |
|---|---|
| `Apoptosis-DC2.4_Group_unstain.fcs` | Negative / unstained control |
| `Apoptosis-DC2.4_Group_positive.fcs` | Positive apoptosis/death control |
| `Apoptosis-DC2.4_Compensation_BL1-A.fcs` | Single-stain compensation control candidate |
| `Apoptosis-DC2.4_Compensation_BL3-A.fcs` | Single-stain compensation control candidate |
| `Apoptosis-DC2.4_Group_1.fcs` | Analysis sample |
| `Apoptosis-DC2.4_Group_2.fcs` | Analysis sample |
| `Apoptosis-DC2.4_Group_3.fcs` | Analysis sample |
| `Apoptosis-DC2.4_Group_5.fcs` | Analysis sample |
| `Apoptosis-DC2.4_Group_6.fcs` | Analysis sample |

Observed channels across inspected files:

```text
Time
FSC-A, SSC-A
Annexin X-FITC-A
PI-PerCP-Cy5.5-A
FSC-H, SSC-H
Annexin X-FITC-H
PI-PerCP-Cy5.5-H
FSC-W, SSC-W
Annexin X-FITC-W
PI-PerCP-Cy5.5-W
```

The inspected files include embedded `$SPILLOVER` metadata. This makes the
folder useful for validating both the explicit compensation workflow and the
apoptosis gating workflow.

Important live-validation detail: the `$SPILLOVER` matrix in these files uses
detector-code channel names:

```text
BL1-A, BL3-A, BL1-H, BL3-H, BL1-W, BL3-W
```

The user-facing FCS parameter names are:

```text
Annexin X-FITC-A, PI-PerCP-Cy5.5-A, ...
```

The FCS metadata does expose the detector mapping (`Annexin X-FITC-A` ->
`BL1-A`, `PI-PerCP-Cy5.5-A` -> `BL3-A`). Live validation must verify that
compensation alignment uses this detector-to-parameter mapping before applying
`compensation_id` to the apoptosis plot. The apoptosis tool itself should pass
only the channels it analyzes to the compensation application path; it should
not require applying all six area/height/width spillover channels.

## Biological Workflow

The recommended apoptosis gating sequence is:

1. Open FCS files and inspect metadata.
2. Discover compensation, but do not apply it unless the user confirms.
3. Gate non-debris cells on FSC-A vs SSC-A.
4. Gate singlets on area vs height or width.
5. Do **not** apply a normal live-cell exclusion gate before apoptosis analysis.
   Dead/apoptotic events are the biology being measured.
6. On the singlet parent population, analyze:

```text
Annexin channel vs membrane-death dye channel
```

Typical quadrant interpretation:

| Quadrant | Interpretation |
|---|---|
| Annexin negative / death dye negative | Viable |
| Annexin positive / death dye negative | Early apoptotic |
| Annexin positive / death dye positive | Late apoptotic / dead |
| Annexin negative / death dye positive | Necrotic / membrane damaged |

The tool should return these labels as defaults, but they should remain
metadata on gates and summaries, not hard-coded assumptions in the workspace
schema.

## Proposed MCP Tool

Add a new read-only MCP tool:

```text
suggest_apoptosis_quadrants
```

### Inputs

```ts
{
  workspace_path: string;
  sample_id: string;
  parent_gate_id?: string;

  annexin_channel: string;
  death_channel: string;

  negative_control?: {
    sample_id?: string;
    fcs_path?: string;
    parent_gate_id?: string;
  };

  positive_control?: {
    sample_id?: string;
    fcs_path?: string;
    parent_gate_id?: string;
  };

  annexin_single_positive_control?: {
    sample_id?: string;
    fcs_path?: string;
  };

  death_single_positive_control?: {
    sample_id?: string;
    fcs_path?: string;
  };

  compensation_id?: string;

  threshold_method?: "negative_control_percentile" | "manual";
  negative_percentile?: number; // default 99.5
  manual_annexin_threshold?: number;
  manual_death_threshold?: number;
}
```

Design notes:

- `annexin_channel` and `death_channel` are required. Channel discovery can
  suggest likely candidates, but the tool contract should stay explicit.
- Control inputs may reference samples already in the workspace or external FCS
  paths. The tool should not guess from filenames as the scientific contract.
- `compensation_id` is optional and agent-explicit. If omitted, the tool uses
  raw values and reports that no compensation was applied.
- `parent_gate_id` should usually be the singlet population, not a live-cell
  gate.

### Output

```ts
{
  ok: true;
  workspacePath: string;
  sampleId: string;
  parent: string;
  axes: {
    x: string; // annexin channel
    y: string; // death channel
  };
  thresholds: {
    annexin: number;
    death: number;
    method: string;
    source: "negative_control" | "manual" | "exploratory";
  };
  gates: WorkspaceGate[];
  summary: {
    viable: PopulationSummary;
    earlyApoptotic: PopulationSummary;
    lateApoptoticDead: PopulationSummary;
    necroticOrMembraneDamaged: PopulationSummary;
  };
  diagnostics: {
    confidence: "control_anchored" | "manual_thresholds" | "exploratory";
    compensation?: {
      applied: boolean;
      id?: string;
    };
    warnings: string[];
  };
  nextAction: {
    tool: "upsert_gates";
    arguments: {
      workspace_path: string;
      expected_revision: number;
      gates: WorkspaceGate[];
    };
  };
}
```

`WorkspaceGate[]` should contain four rectangle gates or quadrant-equivalent
rect gates on the selected parent population.

The rectangle bounds must be finite. The current workspace validator rejects
`Infinity` and `-Infinity` for `xMin`, `xMax`, `yMin`, and `yMax`. For open-ended
quadrants, use finite analysis bounds derived from the parent-filtered plot or
control data, then split those bounds at the Annexin and death-dye thresholds.
For example:

```text
viable:
  xMin = finiteXMin
  xMax = annexinThreshold
  yMin = finiteYMin
  yMax = deathThreshold
```

The result should report the finite bounds used so agents can audit and reuse
the exact quadrant geometry.

## Threshold Strategy

### Primary Method: Negative-Control Percentile

When a negative or unstained control is provided:

1. Apply the same parent gate chain if available.
2. Read `annexin_channel` and `death_channel`.
3. Set thresholds from a high percentile of the negative control:

```text
annexin_threshold = percentile(negative_control_annexin, 99.5)
death_threshold = percentile(negative_control_death, 99.5)
```

Default `negative_percentile`: `99.5`.

The result should report:

- percentile used
- event count used
- whether compensation was applied
- warnings if too few control events remain after parent gating

### Manual Method

If the user provides both manual thresholds, use them exactly.

The tool should report `confidence: "manual_thresholds"` and should not adjust
the thresholds.

### Exploratory Mode

If no negative control and no manual thresholds are available, the tool should
not pretend to make a validated apoptosis call.

Allowed behavior:

- Return plot axes and data diagnostics.
- Return candidate thresholds only as exploratory.
- Ask the user for a negative control or manual threshold confirmation before
  writing gates.

The MCP result should include a warning such as:

```text
No negative control or manual thresholds were provided. Suggested quadrants are exploratory and should not be used as validated apoptosis calls.
```

## Implementation Modules

Add:

```text
src/core/apoptosis.ts
```

Core exports:

```ts
suggestApoptosisQuadrants(input): Promise<SuggestApoptosisQuadrantsResult>
```

Support helpers:

- channel validation
- control event loading
- optional compensation application
- parent gate filtering
- percentile threshold calculation
- quadrant gate construction
- count/percentage summary, preferably reusing `getPopulationGraph` behavior

MCP registration:

```text
suggest_apoptosis_quadrants
```

Skill guidance:

- Add apoptosis-specific instructions to `skills/flowcyto/SKILL.md`.
- Emphasize: parent should usually be non-debris singlets, not live-cell gated.
- Emphasize: ask before applying compensation or writing gates.

## Tests

Use synthetic unit tests first:

1. Negative-control percentile thresholds are deterministic.
2. Manual thresholds are used exactly.
3. Tool returns four quadrant gates and does not write the workspace.
4. Counts match expected quadrant membership on a tiny synthetic FCS.
5. Missing channels return an agent-readable `unknown_channel` error.
6. No controls/manual thresholds returns exploratory diagnostics and warning.
7. Passing `compensation_id` applies compensation explicitly and reports it.
8. Stale writes are still handled by the returned `upsert_gates` nextAction,
   not by this read-only tool.

Live validation using `7_Apoptosis_cwq`:

1. Open unstained and grouped samples into a disposable workspace.
2. Verify compensation discovery from `$SPILLOVER`.
3. Confirm likely channels:

```text
annexin_channel = Annexin X-FITC-A
death_channel = PI-PerCP-Cy5.5-A
```

4. Gate FSC-A/SSC-A parent and singlets.
5. Run `suggest_apoptosis_quadrants` on at least:

```text
Apoptosis-DC2.4_Group_1.fcs
Apoptosis-DC2.4_Group_positive.fcs
Apoptosis-DC2.4_Group_unstain.fcs
```

6. Render before/after SVGs and record:

- threshold values
- quadrant percentages
- compensation state
- detector-code compensation alignment (`BL1-A` -> `Annexin X-FITC-A`,
  `BL3-A` -> `PI-PerCP-Cy5.5-A`)
- warnings
- whether the gates look biologically plausible

Do not commit these FCS files unless redistribution is explicitly cleared.

## Open Questions

1. Should the tool support a batch mode across all group samples in one call, or
   should agents loop sample-by-sample using the same thresholds?

   Recommendation: start sample-by-sample. Add batch mode after the single-sample
   contract is stable.

2. Should thresholds be shared across all treatment groups?

   Recommendation: yes, when they come from the same negative control and same
   compensation state. The tool should return threshold values so agents can
   reuse them explicitly.

3. Should compensation controls be used to estimate a new compensation matrix?

   Recommendation: not inside apoptosis gating. Use the existing
   `estimate_compensation_from_controls -> upsert_compensation_matrix` workflow
   first, then pass the chosen `compensation_id`.

4. Should apoptosis gates be stored as a special gate type?

   Recommendation: no. Store them as ordinary `rect` gates with names/metadata.
   This keeps workspace compatibility and FlowJo export simpler.

## PR Sequence

1. `docs/flowcyto-apoptosis-gating-plan`
   - Add this plan.
2. `feat/flowcyto-apoptosis-quadrants`
   - Add `src/core/apoptosis.ts`.
   - Add `suggest_apoptosis_quadrants` MCP tool.
   - Add synthetic tests.
   - Add skill guidance.
3. `docs/flowcyto-apoptosis-live-validation`
   - Add local validation notes from `7_Apoptosis_cwq`.
   - Do not commit private FCS files.
4. Optional follow-up:
   - Batch application across treatment groups.
   - Report/table export.
   - Comparison against FlowJo expert apoptosis gates if `.wsp` is available.
