# Pre-Compensated and Pre-Unmixed Signal Detection

Date: 2026-09-04

Branch: `test/compensation-precompensated-signals`

Task: Parallel Delegation item 3 of [compensation-unmixing-plan-2026-08-23.md](compensation-unmixing-plan-2026-08-23.md).

## Summary

The headline is a real file pair, not an argument.

`peacoqc-111.fcs` (raw) and `peacoqc-111_Comp_Trans.fcs` (the same sample, already compensated **and** transformed) produce **identical** output from `detectCompensationStatus`. Both are told an embedded matrix is available; both receive a `suggestedCompensationId` pointing at it. An agent that follows the suggestion on the second file double-compensates it.

The compensated export kept its `SPILL` keyword unchanged and kept its detector channel names unprefixed, so every signal the detector looks for is absent from both. This is the plan's Scenario C, and it is not an edge case — it is what a standard FlowJo/R export pipeline produces. Both files are now fixtures, and a test asserts the two statuses are equal.

**No automatic fix is available.** The search for a discriminating signal is documented below, including one that was recommended in an earlier draft and has since been tested and withdrawn. What ships here is a change to stop the output *implying* the two can be told apart.

## Retracted: the negative-value heuristic

An earlier draft of this analysis recommended detecting compensated data by looking for meaningfully negative values in fluorescence channels, on the reasoning that raw integer detector data is non-negative by construction while compensating dim events drives values below zero.

**Tested against the pair, it does not work.** Both files carry negative values in 17 of their 18 fluorescence channels, at comparable rates:

| Channel | Negative events, raw | Negative events, compensated |
|---|---|---|
| B515-A | 3.5% | 1.1% |
| G780-A | 2.9% | 20.6% |
| G710-A | 4.1% | 11.0% |
| B710-A | 3.7% | 3.7% |

The premise was wrong: this is digital BD data stored as `$DATATYPE F`, and the instrument already applies baseline restoration at acquisition, so raw values are routinely negative. The recommendation is withdrawn.

Recording it because it was written down as promising, and a reader who saw the earlier draft should know it was tried and failed rather than quietly dropped.

## What actually distinguishes the pair

Diffing all 296 keywords between the two files, only four differ:

- `$TOT` — 10000 raw, 9617 compensated. The compensated file was QC-filtered. Not a compensation signal; any subset would show this.
- `$BEGINDATA` / `$ENDDATA` — byte offsets, consequent on the above.
- `flowCore_$PnRmax` / `flowCore_$PnRmin` — data range annotations, 262144 raw versus 4.5 compensated.

Only the last is informative, and it is unusable as a general signal: it is a **flowCore-specific keyword**, present only because flowCore wrote the file, and its value reflects the *transform*, not the compensation. A file compensated without being transformed would not show it.

So the honest conclusion is that this pair differs in two ways at once — compensated and transformed — and nothing observable can be attributed to compensation alone.

## Signal table

Behavior below is observed output from `detectCompensationStatus`, not a reading of the source.

### Reliable — positive evidence of pre-processing

| Signal | Verified specimen | Assessment |
|---|---|---|
| `FJComp-` channel prefix | none in this survey | **Reliable when present.** FlowJo writes this prefix only for derived compensated parameters. Correctly strong. |
| `Comp-` channel prefix | none | **Reliable when present.** Same reasoning. |
| `C_` channel prefix | none | **Reliable when present**, but weakest of the three — short enough to collide with a user-named parameter. |

All three set `detectedAsPreCompensated: true` and suppress `suggestedCompensationId`. That is right. The caveat is that these are the plan's own examples and **no redistributable file carrying any of them was found**, so their behavior is verified against synthetic channel lists only.

### Weak — fires on data that is not pre-processed

| Signal | Evidence | Assessment |
|---|---|---|
| "Fluorochrome-like channel names" | Fires on `flowWorkspaceData/diva/124500.fcs` and `a2004_O1T2pb05i_A1_A01.fcs` — both conventional files with real spillover matrices needing compensation | **Poor specificity.** Correctly weak: contributes to `signals` but not to the boolean. |

Its behavior is also inconsistent. `looksLikeFluorochromeChannel` excludes bare names (`FITC-A`, `PE-A`) to avoid flagging conventional panels, but not equally conventional ones (`PerCP-Cy5-5-A`, `Pacific Orange-A`):

```text
["FITC-A", "PE-A", "APC-Cy7-A"]                          -> signals=[]
["FITC-A", "PE-A", "PerCP-Cy5-5-A", "Pacific Orange-A"]  -> signals=["Fluorochrome-like channel names detected"]
```

Whether it fires depends on which fluorochromes the operator happened to use. The deeper reason is that naming does not separate conventional from spectral data at all: conventional panels are routinely labelled with fluorochrome names, and raw Cytek exports are labelled with detector names — the opposite of the plan's assumption.

### Must ask the user

| Situation | Evidence | Why detection cannot decide |
|---|---|---|
| `$CYT` = Aurora / SpectroFlo | synthetic | SpectroFlo exports **both** raw and unmixed files with the same `$CYT`. Observed: raw-style channels `["V1-A","B1-A"]` still yield `detectedAsPreCompensated: true`. The keyword identifies the instrument, never the processing state. Conservative, so acceptable — but a guess, not a detection. |
| `$CYT` = CytoFLEX | synthetic | **Likely false positive.** The Beckman CytoFLEX is a conventional analyzer. `$CYT="CytoFLEX"` with `["FITC-A","PE-A","APC-A"]` and a valid matrix yields `detectedAsPreCompensated: true`, suppressing the suggestion and reporting the data as pre-unmixed. This discourages a legitimate compensation. |
| **Matrix present, no prefix, conventional instrument** | **`peacoqc-111-comp-trans`**, verified | **The dangerous case.** Genuinely compensated, no detectable signal, and the status actively suggests applying the matrix. |
| Identity matrix present | `flowWorkspaceData/a2004_*`, verified | An 8×8 identity `SPILL` is discovered and suggested like any other. Numerically a no-op, but "a matrix exists" and "compensation is needed" are different claims. |

## The change in this PR

`detectCompensationStatus` now emits an explicit signal when a matrix is found and no pre-compensation evidence is present:

```text
Compensation state unverifiable: no signal distinguishes raw from already-compensated data.
```

This does **not** make the two files distinguishable — nothing can. It stops the output from implying they are. Previously the ambiguous case was reported as a bare `suggestedCompensationId` with a generic recommendation string, identical to what a confirmed-raw file would produce. The uncertainty is now machine-readable rather than something a caller has to infer from the absence of signals.

It is additive: `signals` is already `string[]` in the contract, no field is added or removed, and `suggestedCompensationId` still appears for callers that want the convenience.

### The stronger alternative, not taken

The more aggressive tightening is to **stop setting `suggestedCompensationId` entirely** in the ambiguous case. The argument for it: the field is set precisely when `detectedAsPreCompensated` is false, which means "no positive signal", not "confirmed raw" — exactly the `111_Comp_Trans` situation. A field named *suggested* reads as an endorsement no matter what the recommendation string says.

The argument against: it removes a real convenience for the common case, where data genuinely is raw, and since no positive raw-evidence signal exists, gating on one would mean never setting it at all.

Left to reviewers. Preferring it means deleting the `suggestedCompensationId` assignment; the fixtures and the test in this PR stand either way.

## Recommendations not implemented here

1. **Drop `CytoFLEX` from the spectral keyword list**, or split spectral detection into "spectral instrument" and "spectral export". Flagging a conventional analyzer as pre-unmixed suppresses correct compensation.
2. **Distinguish an identity matrix from a real one** in `list_compensations`. Cheap, and prevents suggesting a no-op.
3. **Get a FlowJo-exported fixture.** The three prefix signals are almost certainly correct but have no real-file coverage. This is the strongest argument for FlowRepository API access.

## Reproducing

```bash
npm run fixtures:fetch
npm test
```

Both PeacoQC fixtures are in `testdata/fixtures/manifest.json` with their spillover evidence pinned and their `classification` recorded. The synthetic signal cases quoted above were produced by driving `detectCompensationStatus` across a case list directly.
