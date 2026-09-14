# Bead Compensation Bright-Event Validation

Date: 2026-09-12

Follow-up to: `docs/compensation-bead-live-validation-2026-09-12.md`

Implemented in: PR #17 (`feat/bright-event-compensation`)

## Change Validated

Added `event_selection: { type: "primary_channel_top_percentile", percentile }` to
`estimate_compensation_from_controls`. This selects only the top `(100 - percentile)%`
of events by background-corrected primary channel signal before computing the
median ratio.

## Dataset

```text
C:\Users\fangxf\Research Tools\Flow data\test_aurora_1
```

8 channels (AF-A excluded — no single-stain control present):

```text
eFluor 450-A, BV785-A, FITC-A, PerCP-Cy5.5-A, PE-A, TexasRed-A, PE-Cy7-A, APC-A
```

Reference: embedded `$SPILLOVER` matrix in the unstained bead file (9 channels
including AF-A; AF-A row/column excluded from comparison).

## Results

### All-event median vs embedded

Max off-diagonal |error|: **1.00891** (PerCP-Cy5.5-A → PE-A)

| Source | Destination | All-event | Embedded | \|Δ\| |
|---|---|---:|---:|---:|
| `PerCP-Cy5.5-A` | `PE-A` | 1.00891 | 0.00000 | 1.00891 |
| `eFluor 450-A` | `PE-A` | -0.34344 | 0.00000 | 0.34344 |
| `BV785-A` | `PE-A` | 0.34146 | 0.00000 | 0.34146 |
| `PerCP-Cy5.5-A` | `eFluor 450-A` | 0.24570 | 0.00000 | 0.24570 |
| `PerCP-Cy5.5-A` | `TexasRed-A` | -0.13081 | 0.00000 | 0.13081 |

### Bright-event median (percentile=90) vs embedded

Max off-diagonal |error|: **0.02434** (eFluor 450-A → PE-A)

| Source | Destination | Bright(90) | Embedded | \|Δ\| |
|---|---|---:|---:|---:|
| `eFluor 450-A` | `PE-A` | -0.02434 | 0.00000 | 0.02434 |
| `PerCP-Cy5.5-A` | `PE-A` | 0.00951 | 0.00000 | 0.00951 |
| `PerCP-Cy5.5-A` | `TexasRed-A` | -0.00789 | 0.00000 | 0.00789 |
| `PerCP-Cy5.5-A` | `APC-A` | 0.00650 | 0.00000 | 0.00650 |
| `eFluor 450-A` | `FITC-A` | 0.00481 | 0.00000 | 0.00481 |

### Error reduction summary

| Estimator | Max \|error\| off-diagonal |
|---|---:|
| All-event median | 1.00891 |
| Bright-event median (90) | 0.02434 |
| Improvement factor | ~41× |

### Events selected per control (percentile=90)

| Control | Selected events | Total sampled |
|---|---:|---:|
| eFluor 450-A | 684 | 6,832 |
| BV785-A | 510 | 5,094 |
| FITC-A | 508 | 5,079 |
| PerCP-Cy5.5-A | 508 | 5,076 |
| PE-A | 508 | 5,074 |
| TexasRed-A | 507 | 5,069 |
| PE-Cy7-A | 511 | 5,103 |
| APC-A | 509 | 5,086 |

Each bead file has ~5,000 total events. At percentile=90 the top 10% (~500) are
selected — consistent with approximately 10% bright positive beads in a mixed
negative/positive bead preparation.

## Interpretation

The PerCP-Cy5.5 bead control shows the most severe all-event failure (→PE-A:
1.009). This is caused by the negative bead subpopulation having non-background
PE-A signal not explained by PerCP spillover. The bright-event selection
eliminates that subpopulation from the median computation and reduces the error
by a factor of ~41.

The remaining largest error after bright-event selection is eFluor 450-A → PE-A
(0.02434). This is consistent with the earlier manual check from PR #16. The
magnitude is small enough that it should have negligible effect on quadrant gating.

## Validation Status

- Bright-event median (percentile=90) is substantially closer to the embedded
  matrix on this mixed bead dataset.
- Max off-diagonal error drops from >1.0 to <0.025.
- The default all-event behavior is unchanged for flowCore-style controls
  where all events are from a uniform bright population.
- The `event_selection` parameter is explicit and opt-in; no silent behavior
  change for existing callers.

## Pending

- Add agent guidance to `skills/flowcyto/SKILL.md`: when to use
  `event_selection` vs default.
- Decide whether any public bead-control dataset can be committed as a fixture
  for regression testing on mixed populations.
- Check whether `eFluor 450-A → PE-A` residual (0.024) warrants further
  investigation or is within acceptable range for apoptosis gating.
