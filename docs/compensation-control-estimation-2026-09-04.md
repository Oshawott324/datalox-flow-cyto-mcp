# Control-Derived Compensation: Validation

Date: 2026-09-04

Branch: `docs/compensation-control-estimation`

Task: Parallel Delegation item 4 of [compensation-unmixing-plan-2026-08-23.md](compensation-unmixing-plan-2026-08-23.md). Validates the estimator merged in #8, rather than preparing for it.

## Summary

The shipped estimator got the two design decisions that matter **right**: it uses the median method, and it requires an explicit `{path, channel}` mapping with no filename inference. Both match what this analysis independently concludes they should be.

It had two defects, one now fixed:

1. **Transposed output** — returned row = detector instead of row = fluorochrome, disagreeing with the embedded-keyword path through the same `applyCompensationColumns`. Fixed in `fix/compensation-matrix-orientation`.
2. **No `$PnE` linearization** — still open. On log-amplified data the estimate is wrong by a factor of 3–5.

Against flowCore's published matrix, using its own five controls:

| State | max abs error vs `compref` |
|---|---|
| As merged | 0.71533 |
| With orientation fixed | 0.52646 |
| Correct algorithm | **3.6e-16** |

The residual 0.526 is entirely the `$PnE` gap.

## The algorithm, fully specified

Four steps. Every one is load-bearing.

1. **Linearize per `$PnE`.** For each parameter with `$PnE = f1,f2` and `f1 > 0`: `linear = (f2 or 1) · 10^(f1 · x / $PnR)`.
2. **Take the per-channel median** of each single-stain control.
3. **Subtract the unstained control's per-channel medians.**
4. **Row-normalize** each control's row by its own stain channel.

Steps 2–4 are what `estimateCompensationFromControls` does. Step 1 is missing.

Row `i` is the control for channel `i`; entry `[i][j]` is that stain's signal in detector `j` — the convention in [compensation-numeric-validation-2026-09-04.md](compensation-numeric-validation-2026-09-04.md).

### Step 1 is not optional

FACSCalibur fluorescence channels are stored as 4-decade log values (`$PnE = 4,0`). Estimating on stored values without linearizing:

| Coefficient | flowCore | Without linearization |
|---|---|---|
| FL1-H → FL2-H | 0.2420 | 0.7231 (**3.0×**) |
| FL2-H → FL3-H | 0.1408 | 0.6673 (**4.7×**) |

Not a degradation — a different matrix. `readFcsColumns` has no `$PnE` handling, so this is live for any log-amplified control set.

It is also a **latent risk in the apply path**, though not currently a live bug there: `applyCompensationColumns` operates on stored values with no `$PnE` check. Every spillover-bearing fixture found is digital and linear (`$PnE = 0,0`), so it is correct on all of them, but a log-amplified file carrying a spillover keyword would be silently mis-compensated.

## Estimator comparison

Against `compref`, which flowCore's own `spillover()` produced from these five controls.

| Estimator | Max abs error | Verdict |
|---|---|---|
| **Median, background-subtracted, linearized** | **3.6e-16** | Exact reproduction |
| Bright-event OLS, top 50% | 0.0654 | Diverges |
| Bright-event OLS, top 20% | 0.0726 | Diverges |
| Bright-event OLS, top 10% | 0.0750 | Diverges |
| Bright-event OLS, top 5% | 0.0763 | Diverges |
| Bright-event OLS, top 1% | 0.0720 | Diverges |

Where the OLS variant lands on the coefficients that matter (top 10%):

| Spill | flowCore | OLS | Error |
|---|---|---|---|
| FL3-H → FL4-H | 0.2296 | 0.1546 | **−32.7%** |
| FL3-H → FL2-H | 0.1756 | 0.1360 | **−22.5%** |
| FL2-H → FL3-H | 0.1408 | 0.1589 | +12.9% |
| FL1-H → FL2-H | 0.2420 | 0.2581 | +6.6% |

Divergence concentrates in the **largest** coefficients, and tightening the percentile makes it worse. This matters mainly as a warning against switching methods: the plan proposes porting the old Datalox `build_spillover_from_controls`, which is described as a bright-event percentile regression. The merged estimator does not do that, and should not start.

Two caveats. The OLS variant here is **reconstructed from the plan's description**, not ported from the Datalox source, which was unavailable — the real implementation may include gating or regularization that changes these numbers. And divergence alone does not make OLS *wrong*; the methods estimate slightly different quantities. But `compref` is the field-standard tool's output, so an estimator differing by 0.075 will visibly disagree with flowCore and FlowJo.

## Failure modes

### Filename-order mapping — catastrophic, and silent

flowCore's `comp_match` maps `.003→FL2-H`, `.004→FL4-H`, `.005→FL3-H`. Ordinal order is **wrong**, and the filenames (`060909.002`) carry no channel information.

| Metric | Correct mapping | Filename-ordinal |
|---|---|---|
| Max abs error vs compref | 3.6e-16 | **310.5** |
| Condition number | 1.565 | **358.8** |

One coefficient reaches **310.7** where the true value is 0.23. The matrix stays invertible, so nothing errors — it inverts, applies, and produces garbage.

The strongest possible support for the plan's boundary, and not hypothetical: **the reference dataset in this field is itself ordered so that guessing fails**, which is presumably why flowCore ships a mapping file. The shipped estimator already requires explicit mapping, so this is a reason to keep it that way rather than a defect. A test asserts the fixture set keeps a corpus where ordinal guessing would be wrong.

The practical corollary: a mis-mapped estimate cannot be spotted from the coefficients, but its **conditioning is off by two orders of magnitude**. Reporting the condition number in the estimator result would be the cheapest available guardrail.

### Missing unstained control

`unstainedPath` is optional and defaults to zero background. Skipping it costs **0.101** max abs error:

| Spill | flowCore | No subtraction | Error |
|---|---|---|---|
| FL3-H → FL4-H | 0.2296 | 0.3308 | **+44.1%** |
| FL3-H → FL2-H | 0.1756 | 0.2371 | +35.1% |

It should be required, or at minimum the result should say the estimate is uncorrected.

### Insufficient events

Median estimator on subsampled controls, 20 fixed seeds per size:

| Events/control | Median error | Worst of 20 |
|---|---|---|
| 2000 | 0.0040 | 0.0111 |
| 1000 | 0.0076 | 0.0218 |
| 300 | 0.0115 | 0.0299 |
| 100 | 0.0281 | 0.0636 |
| 30 | 0.0382 | 0.1398 |
| 10 | 0.0705 | **0.5042** |

Degradation is graceful with **no natural cliff**, which is the problem: at 30 events the median case looks tolerable while the worst case is already 0.14. A minimum-event threshold belongs in the tool contract as an explicit, overridable parameter rather than being inferred from result quality. The estimator currently enforces none.

### Dim controls and tandem dyes — not covered

The plan asks for both; neither is testable here. All four controls are bright and well separated, and FACSCalibur FL1–FL4 carries no tandem dye. Simulating dimness by attenuating a channel would only re-measure the event-count sensitivity above under a different label.

Closing these needs a panel with a real tandem (PE-Cy7 or APC-Cy7, where spillover shifts with tandem degradation between lots) and a genuinely dim stain — most likely from FlowRepository, which needs API access.

## Remaining recommendations

Ordered by value. None are implemented here.

1. **Linearize per `$PnE`**, or refuse log-amplified input with a structured error. Currently the only thing between a user and a 3–5× wrong matrix.
2. **Require an unstained control**, or report that the estimate is background-uncorrected.
3. **Add an explicit minimum-event threshold**, refusing rather than degrading below it.
4. **Report the condition number** in the estimator result.

## Reproducing

```bash
npm run fixtures:fetch
python3 scripts/control-compensation-reference.py   # requires numpy
npm test
```

`scripts/control-compensation-reference.py` reads the control mapping from the `control` blocks in `testdata/fixtures/manifest.json` (transcribed from `comp_match`) and writes a committed JSON reference, so the suite never needs Python. Deterministic — fixed seeds, verified by regenerating and comparing MD5.
