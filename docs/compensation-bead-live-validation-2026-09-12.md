# Bead Compensation Live Validation

Date: 2026-09-12

Local validation dataset, not committed:

```text
C:\Users\fangxf\Research Tools\Flow data\test_aurora_1
```

Related old Datalox source reviewed:

```text
Complexity-LLC/datalox@flowcyto-mcp-tool-loading
backend/domains/flow_cytometry/compensation/compensation.py
backend/domains/flow_cytometry/compensation/parse_spillover_align.py
```

## Purpose

Validate the current MCP control-derived compensation path on a real multi-stain
bead panel and decide what, if anything, should be ported from the old
`flowcyto-mcp-tool-loading` branch.

The relevant MCP tools already exist:

```text
estimate_compensation_from_controls
upsert_compensation_matrix
```

So this is not blocked on tool implementation. The open question is whether the
current estimator is sufficient for bead controls with mixed negative/positive
events.

## Dataset

Controls:

| Role | File | Explicit channel mapping |
|---|---|---|
| Unstained | `Unstained (Beads).fcs` | background |
| APC | `APC (Beads).fcs` | `APC-A` |
| BV785 | `BV785 (Beads).fcs` | `BV785-A` |
| FITC | `FITC (Beads).fcs` | `FITC-A` |
| PE | `PE (Beads).fcs` | `PE-A` |
| PE-Cy7 | `PE-Cy7 (Beads).fcs` | `PE-Cy7-A` |
| PerCP-Cy5.5 | `PerCP-Cy5.5 (Beads).fcs` | `PerCP-Cy5.5-A` |
| TexasRed | `TexasRed (Beads).fcs` | `TexasRed-A` |
| eFluor 450 | `eFluor 450 (Cells).fcs` | `eFluor 450-A` |

Analysis samples in the same folder:

```text
concat_PBS.fcs
concat_LPS.fcs
concat_DEX.fcs
concat_DEX+LPS.fcs
concat_GUA.fcs
concat_GUA+LPS.fcs
concat_IL-10+TGF-b.fcs
concat_IL-10+TGF-b+LPS.fcs
```

The treatment samples expose already-compensated `FJComp-*` channels and do not
carry `$SPILLOVER`. The controls expose raw detector channels and carry an
embedded `$SPILLOVER` matrix.

Channels used for this validation:

```text
eFluor 450-A
BV785-A
FITC-A
PerCP-Cy5.5-A
PE-A
TexasRed-A
PE-Cy7-A
APC-A
```

`AF-A` is present in the control files and embedded matrix, but no matching
single-stain control was found in this folder. It is excluded from this
control-derived validation.

## Current MCP Estimator

Current implementation:

```text
src/core/compensation-controls.ts
method = median_ratio
```

It:

1. Reads each explicit single-stain control.
2. Computes per-channel medians across all events.
3. Subtracts unstained medians.
4. Divides by the primary-channel signal for the control.

This matched the external flowCore reference fixture in earlier validation, but
that fixture is not a mixed bead positive/negative population in the same way as
this Aurora bead folder.

## Old Branch Reference

The old Datalox `build_spillover_from_controls` function uses:

```text
bright_q = 0.90
top bright events in the primary channel
OLS slope against every detector
```

Do not copy it directly:

- It maps controls from filenames, which is not acceptable as the MCP contract.
- It uses OLS slopes, which previously disagreed with flowCore's published
  control-derived fixture.
- It is Python/Pandas workflow code, not the current TypeScript MCP model.

The useful idea to reuse is narrower:

```text
single-stain bead controls should estimate spillover from the bright positive population, not from all events.
```

## Live Validation Results

### Current all-event median estimator

The current `estimateCompensationFromControls` call completed successfully with
explicit mappings, but the matrix disagreed strongly with the embedded
`$SPILLOVER` matrix. Largest off-diagonal differences:

| Source | Destination | Current estimate | Embedded | Absolute diff |
|---|---:|---:|---:|---:|
| `PerCP-Cy5.5-A` | `PE-A` | 1.00891 | 0 | 1.00891 |
| `eFluor 450-A` | `PE-A` | -0.34344 | 0 | 0.34344 |
| `BV785-A` | `PE-A` | 0.34146 | 0 | 0.34146 |
| `PerCP-Cy5.5-A` | `eFluor 450-A` | 0.24570 | 0 | 0.24570 |
| `PerCP-Cy5.5-A` | `TexasRed-A` | -0.13081 | 0 | 0.13081 |

Interpretation:

- The all-event median is not valid for these controls.
- Mixed negative/positive bead events pull the median toward the negative bead
  population for some controls.
- This is a real validation failure for this dataset, not an MCP schema issue.

### Old-branch-inspired bright OLS check

An ad hoc local check reproduced the old branch's bright-event OLS idea using
the top 10% primary-channel events after unstained subtraction.

Largest off-diagonal differences:

| Source | Destination | Bright OLS estimate | Embedded | Absolute diff |
|---|---:|---:|---:|---:|
| `BV785-A` | `eFluor 450-A` | 0.09525 | 0 | 0.09524 |
| `BV785-A` | `PE-Cy7-A` | 0.07513 | 0 | 0.07513 |
| `BV785-A` | `PerCP-Cy5.5-A` | 0.03169 | 0 | 0.03169 |
| `BV785-A` | `APC-A` | 0.02303 | 0 | 0.02303 |
| `BV785-A` | `TexasRed-A` | -0.02074 | 0 | 0.02074 |

Interpretation:

- Bright-event selection helps, but the OLS variant still produces noticeable
  disagreement for this panel.
- This supports the earlier decision not to port the old Python function
  directly.

### Bright-event median-ratio check

A local check used the same top 10% primary-channel event selection, but kept
the current estimator's median-ratio math.

Largest off-diagonal differences:

| Source | Destination | Bright median estimate | Embedded | Absolute diff |
|---|---:|---:|---:|---:|
| `eFluor 450-A` | `PE-A` | -0.02434 | 0 | 0.02434 |
| `PerCP-Cy5.5-A` | `PE-A` | 0.00951 | 0 | 0.00951 |
| `PerCP-Cy5.5-A` | `TexasRed-A` | -0.00789 | 0 | 0.00789 |
| `PerCP-Cy5.5-A` | `APC-A` | 0.00650 | 0 | 0.00650 |
| `eFluor 450-A` | `FITC-A` | 0.00481 | 0 | 0.00481 |

Interpretation:

- Bright-event median-ratio is substantially closer to the embedded matrix on
  this dataset than either all-event median-ratio or bright OLS.
- This is the best candidate for a future estimator extension, but it should be
  explicit and tested rather than silently replacing the existing method.

## Recommendation

Create a follow-up implementation PR for explicit bright-event control
selection:

```text
estimate_compensation_from_controls({
  method: "median_ratio",
  event_selection: {
    type: "primary_channel_top_percentile",
    percentile: 90
  }
})
```

Suggested constraints:

- Keep the current default behavior unchanged to avoid breaking the flowCore
  reference fixture.
- Require explicit control-to-channel mappings, as today.
- Add diagnostics:
  - event selection method
  - percentile
  - events selected per control
  - primary-channel median before/after background subtraction
- Reject controls with too few selected events.
- Do not add filename-based control mapping.
- Do not port old OLS as the default.

## Validation Status

Validated:

- The existing MCP compensation-estimation tool exists and is callable.
- The real bead control files can be read by the TypeScript FCS reader.
- Explicit control mappings are sufficient for this folder.
- Current all-event median estimator is not appropriate for this folder.
- Old branch bright-event selection is relevant, but old OLS should not be
  copied directly.

Pending:

- Implement explicit bright-event median-ratio selection.
- Add synthetic tests covering mixed negative/positive bead controls.
- Re-run this local validation after the estimator extension.
- Decide whether any public bead-control dataset can be committed as a fixture.
