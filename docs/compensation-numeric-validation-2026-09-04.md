# Compensation Numeric Validation

Date: 2026-09-04

Branch: `docs/compensation-numeric-validation`

Task: Parallel Delegation item 2 of [compensation-unmixing-plan-2026-08-23.md](compensation-unmixing-plan-2026-08-23.md). Supplies the evidence for the orientation correction in `fix/compensation-matrix-orientation`.

## Summary

The compensation math is **correct**. Cross-checked against numpy/LAPACK over five cases including an externally published matrix; agreement is within 1e-9 relative.

The **documentation** of that math was transposed, and that documentation error propagated into shipped code. `CompensationMatrix.matrix` was described as "fraction of fluorochrome `j` spilling into detector `i`", the transpose of both the implementation and the FCS convention. `estimateCompensationFromControls` (#8) was then written to match the comment rather than the code, and returned transposed matrices until `fix/compensation-matrix-orientation`.

That is the whole argument for pinning orientation in an executable fixture rather than a comment: a transposed spillover matrix still inverts, still applies, and still produces plausible numbers.

## Orientation

```text
S[i][j] = fraction of fluorochrome i's signal that appears in detector j
          row    = source fluorochrome
          column = destination detector

Xcomp = Xraw · inv(S)     computed as   solve(S.T, Xraw.T).T
```

Three independent confirmations that row = fluorochrome:

1. **Algebraic.** `Xcomp = Xraw·inv(S)` implies `Xraw = Xcomp·S`, so `Xraw[e][d] = Σ_f Xcomp[e][f]·S[f][d]`. The summation index `f` is the row index and ranges over fluorochromes.
2. **flowCore's published matrix.** `extdata/compdata/compref` has row `FL1-H` = `[1, 0.242, 0.032, 0.0011]` — the FL1 single-stain control spilling 24.2% into FL2. Rows are named for the stain.
3. **Real instrument data.** In a 13×13 `SPILL` from a BD LSRII, row `G560-A` is `[0.00085, 1, 0.391, 0.208, …]`. G560 is the PE detector, and PE spills into the adjacent longer-wavelength detectors G610 and G660 — along the row. If rows were detectors, those values would sit in a column.

### Worked example

Check by hand. Take `asymmetric_2x2`:

```text
S = [ 1.00  0.20 ]     row FITC: 20% of FITC lands in the PE detector
    [ 0.05  1.00 ]     row PE:    5% of PE lands in the FITC detector

Xraw = [100, 200]      one event
```

Solve `Xraw = Xcomp·S` for `Xcomp = [a, b]`:

```text
a·1.00 + b·0.05 = 100     (FITC detector reading)
a·0.20 + b·1.00 = 200     (PE detector reading)

b = 200 − 0.20a
a + 0.05(200 − 0.20a) = 100
0.99a = 90
a = 90.909090…
b = 200 − 0.20(90.909090…) = 181.818181…
```

Matching the committed expected value `[90.9090909091, 181.818181818]`. Transpose `S` and `a` becomes 60.606… — the difference that lets the fixture detect an orientation error.

## Reference fixture

[scripts/compensation-reference.py](../scripts/compensation-reference.py) → `testdata/fixtures/compensation-reference.json` (committed; the suite never needs Python).

| Case | Size | cond(S) | Purpose |
|---|---|---|---|
| `identity_2x2` | 2×2 | 1.00 | No-op baseline. Includes zero and negative events, both legitimate in compensated data. |
| `asymmetric_2x2` | 2×2 | 1.28 | **Orientation discriminator.** Off-diagonals 0.20 vs 0.05. |
| `asymmetric_3x3` | 3×3 | 1.31 | Realistic forward-cascading spill. |
| `flowcore_compref_4x4` | 4×4 | 1.56 | **Externally published** matrix from flowCore, not one we invented. |
| `near_singular_2x2` | 2×2 | 78.96 | Documents where precision degrades. |

Two properties are load-bearing:

**Asymmetry.** A symmetric matrix gives identical results under either orientation, so a test built only on symmetric fixtures would pass against a transposed implementation. A second test enumerates the cases, transposes each asymmetric one, and asserts the output actually changes — the fixture cannot silently lose this property.

**Independence.** numpy dispatches to LAPACK; the implementation uses ml-matrix's own LU. Different code paths, so agreement is evidence rather than tautology. The generator also asserts `Xcomp·S == Xraw` before writing, catching an orientation error *in the generator itself* — a failure the TypeScript test could not distinguish from a TypeScript bug.

### Near-singular behavior

`near_singular_2x2` uses `S = [[1, 0.98], [0.97, 1]]`, cond ≈ 79. The solve succeeds; input error is amplified by roughly the condition number. The second event, raw `[500, 490]`, compensates to exactly `[500, 0]` — heavy spillover means a large reading in the second detector is fully explained by the first fluorochrome.

A **precision caveat, not an error case**: `singular_compensation_matrix` is raised only when the solve itself throws. Panels with near-singular matrices (tandem dyes on adjacent detectors) compensate without warning while amplifying noise. Whether to surface a conditioning warning is a product decision, deliberately not made here.

## Tolerance

Relative, `max(|expected|, 1) × 1e-9`. Not exact equality: the JSON is rounded to 12 significant digits so it stays byte-stable across BLAS builds, and elimination orders differ between libraries. Real spillover coefficients are quoted to 3–4 significant figures, so 1e-9 relative is orders of magnitude tighter than anything that could change a result.

## Verification performed

| Check | Result |
|---|---|
| ml-matrix vs numpy, all 5 cases | agree within 1e-9 relative |
| Generator round-trip `Xcomp·S == Xraw` | max error < 1e-9, all cases |
| Regenerate twice, compare MD5 | identical (`70b29004…`) |
| Transpose the implementation, rerun | **fails**: `asymmetric_2x2 [0][0] expected 90.9090909091, got 60.6060606060606` |
| Revert transpose | passes; `git diff` clean |

The transpose check is the one that matters. A passing test only proves something if it can fail.

## Regenerating

```bash
python3 scripts/compensation-reference.py   # requires numpy; not a project dependency
```

Deterministic — nothing in the payload depends on time, environment, or iteration order.
