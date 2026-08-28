# PR1 Conventional Compensation Live Validation

Date: 2026-08-27

Branch: `feat/flowcyto-conventional-compensation`

## Scope

Validate PR1 conventional compensation behavior against:

- Deterministic synthetic FCS tests with embedded `$SPILLOVER`.
- Local demo FCS files from the tetramer staining dataset.

PR1 remains agent-explicit: compensation is never applied unless the caller passes `compensation_id` to preview/render/editor tools.

## Automated Validation

Commands run:

```powershell
npm run check
npm test
```

Result:

- TypeScript check passed.
- Vitest passed: 41 tests.

Additional package smoke validation was run earlier on this branch:

```powershell
npm run smoke:package -- --keep-tarball
```

Result:

- Package smoke passed after allowing npm to write to the user npm cache.

## Synthetic FCS Coverage

Added a tiny deterministic integer FCS fixture generator inside `tests/core.test.ts`.

Synthetic file contents:

- Channels: `FSC-A`, `SSC-A`, `FITC-A`, `PE-A`
- `$SPILLOVER`: `2,FITC-A,PE-A,1,0.2,0.1,1`
- Rows include known raw values such as `FITC-A=12`, `PE-A=21`.

Verified:

- `openFcsArtifact` stores the embedded matrix in `workspace.compensations`.
- `openFcsArtifact` returns `compensationSummary.available=true`.
- Raw preview omits `compensation`.
- Preview with `compensationId=fcs_spillover_comp_sample` returns compensated values.
- `open_fcs.nextAction` does not auto-carry `compensation_id`.
- MCP `list_compensations` and `get_compensation_matrix` expose the matrix.
- MCP `render_plot` applies compensation only with explicit `compensation_id`.
- Unknown compensation ids return structured `FlowcytoError` at `/compensation_id`.

## Demo FCS Dataset

Input directory:

```text
C:\Users\fangxf\Research Tools\test data\3. flow\2_20211001_Tet
```

Temporary validation output directory:

```text
C:\tmp\flowcyto-pr1-live-validation
```

Files tested:

- `A1 eFluor 450 Fixable Viability.fcs`
- `A12 FMO Tet.fcs`
- `A2 FITC.fcs`
- `A3 PE (R-phycoerythrin).fcs`
- `A4 APC (Allophycocyanin).fcs`
- `A5 Negative Control.fcs`
- `B1 44 1-1.fcs`
- `B5 44 2-1.fcs`

Observed common channel pattern:

- Visible parameter names include `FITC-A`, `PE (R-phycoerythrin)-A`, `eFluor 450 Fixable Viability-A`, and `APC (Allophycocyanin)-A`.
- Embedded `$SPILLOVER` matrix channels use detector names: `FL03-A`, `FL13-A`, `FL19-A`, `FL26-A`.
- FCS metadata maps those detectors to visible marker/channel names.

Initial live validation found a real alignment gap:

```text
unknown_parameter at /x: Parameter FL03-A is not present.
```

Fix applied:

- `alignCompensationMatrix` now accepts channel alias records with `name`, `detector`, and `marker`.
- Preview generation passes FCS parameter metadata into alignment.
- The aligned compensation matrix returns visible channel names for preview/render use.

Second live validation result:

- All eight files opened successfully.
- Each file stored one embedded compensation matrix.
- Each file returned `compensationSummary.available=true`.
- Each file returned a stable `suggestedCompensationId`.
- Rendering `FITC-A` vs `PE (R-phycoerythrin)-A` with explicit `compensation_id` succeeded.
- Each render wrote an SVG under `.datalox/cache/plots` inside its temporary workspace.
- `renderPlotImage` reported applied compensation metadata with visible channel names.

Example from `B1 44 1-1.fcs`:

```json
{
  "sampleId": "B1_44_1-1",
  "compensationId": "fcs_spillover_B1_44_1-1",
  "compensationChannels": ["FL03-A", "FL13-A", "FL19-A", "FL26-A"],
  "renderCompensation": {
    "applied": true,
    "id": "fcs_spillover_B1_44_1-1",
    "source": "fcs_keyword",
    "channels": [
      "FITC-A",
      "PE (R-phycoerythrin)-A",
      "eFluor 450 Fixable Viability-A",
      "APC (Allophycocyanin)-A"
    ]
  }
}
```

## Pre-Compensation Signal Adjustment

Initial implementation treated fluorochrome-like channel names alone as strong pre-compensated/pre-unmixed evidence.

Live data showed this was too strict for conventional files whose visible parameter names are fluorochrome labels.

Fix applied:

- `FJComp-`, `Comp-`, `C_`, and spectral `$CYT` evidence remain strong signals.
- Fluorochrome-like channel names remain reported as a signal, but do not by themselves suppress `suggestedCompensationId`.

Result:

- Demo files still report the fluorochrome-name signal for agent visibility.
- `detectedAsPreCompensated=false` when no strong signal is present.
- The recommendation still tells the agent to confirm whether acquisition/export already compensated the data before applying the embedded matrix.

## Current PR1 Status

Acceptance criteria covered:

- Embedded FCS spillover matrices are discovered.
- Agents can list and inspect matrices.
- Agents can explicitly render compensated preview/image data by passing `compensation_id`.
- Raw behavior remains unchanged when no compensation is requested.
- Tests pass.
- Live validation records exact files and outputs.

## Fixture Candidate Checks

Input directory:

```text
C:\Users\fangxf\Research Tools\Flow data\3_parsing_test
```

Files checked:

- `2_Accuri_C6.fcs`
- `5_BD_FACSCANTO_II_filtered.fcs`

Results:

- `2_Accuri_C6.fcs`
  - Size: 114,685 bytes.
  - Events: 2,000.
  - Parameters: 14.
  - Embedded keyword: `$SPILLOVER`.
  - Matrix shape: 8 x 8.
  - Matrix channels are numeric parameter references: `3`, `4`, `5`, `6`, `9`, `10`, `11`, `12`.
  - Fixed by resolving numeric references through FCS parameter order:
    - `3` -> `FL1-A`
    - `4` -> `FL2-A`
    - `5` -> `FL3-A`
    - `6` -> `FL4-A`
    - `9` -> `FL1-H`
    - `10` -> `FL2-H`
    - `11` -> `FL3-H`
    - `12` -> `FL4-H`
  - Exact detector/channel matching now takes precedence over suffix-stripped matching, so `FL1-A` does not ambiguously match `FL1-H`.
  - Explicit compensated preview of `FL1-A` vs `FL2-A` succeeds.

- `5_BD_FACSCANTO_II_filtered.fcs`
  - Size: 418,671 bytes.
  - Events: 11,556.
  - Parameters: 9.
  - Embedded keyword: `$SPILLOVER`.
  - Matrix shape: 6 x 6.
  - Matrix channels are named fluorescence channels: `FITC-A`, `PE-A`, `PerCP-Cy5-5-A`, `PE-Cy7-A`, `APC-A`, `APC-Cy7-A`.
  - Compensation discovery succeeds.

Recommendation:

- These two files are technically useful PR1 fixture candidates because they cover different embedded `$SPILLOVER` channel conventions.
- Add them to `testdata/fixtures` only if redistribution rights are clear.
- If rights are uncertain, keep them as local live-validation references and do not commit the FCS binaries.

## Marker Alias Coverage

A common BD-style naming pattern is:

```text
$SPILLOVER channels: FITC, PE
$PnN detector names: FL1-A, FL2-A
$PnS marker names:   FITC, PE
```

This is covered by the same alias path added for detector/visible-name alignment:

- FCS metadata keeps both `$PnN` as `detector` and `$PnS` as `marker`.
- `alignCompensationMatrix` matches matrix channels against `name`, `detector`, and `marker`.
- The aligned matrix returns the canonical preview channel names, so callers can still render `FL1-A` vs `FL2-A`.

Regression coverage:

- Synthetic FCS with partial `$PnS` marker metadata keeps display names as `$PnN`.
- Embedded `$SPILLOVER` uses fluorochrome labels `FITC` and `PE`.
- Explicit compensated preview of `FL1-A` vs `FL2-A` succeeds.
