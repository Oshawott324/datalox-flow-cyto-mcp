# Compensation Fixture Inventory

Date: 2026-09-04

Branch: `fix/compensation-fixture-manifest`

Task: Parallel Delegation item 1 of [compensation-unmixing-plan-2026-08-23.md](compensation-unmixing-plan-2026-08-23.md).

## Summary

Every file below was downloaded and its FCS TEXT segment read directly. Nothing here is inferred from package documentation.

The finding that matters: **`flowcore-comp-060909.001.fcs` carries no spillover keyword of any variant.** The plan names it the candidate baseline for PR1 live validation. It is not one — it is an unstained control from a single-stain set, and its value to this project is for control-derived estimation, not for embedded-matrix work.

PeacoQC's `111.fcs` is the baseline that was actually needed: a real BD FACSDiva `SPILL` matrix, 1.5 MB to fetch, and the compensation code parses it correctly today.

## Inventory

| Fixture | Instrument / writer | FCS | Keyword | Matrix | Channel naming | Class |
|---|---|---|---|---|---|---|
| `local-cfp-well-a4` | MACSQuant / MACSQuantify 2.4 | 3.0 | none | — | detector (`V2-A`, `Y2-A`, `B1-A`) | raw |
| `flowcore-0877408774-B08` | FACSCalibur / CellQuest 3.3 | 2.0 | none | — | detector (`FL1-H`…`FL4-H`) | raw |
| `flowcore-0877408774-E07` | FACSCalibur / CellQuest 3.3 | 2.0 | none | — | detector (`FL1-H`…`FL4-H`) | raw |
| `flowcore-comp-060909-001` | FACSCalibur / CellQuest 3.3 | 2.0 | **none** | — | detector (`FL1-H`…`FL4-H`) | raw (unstained control) |
| `peacoqc-111-raw` | LSRII / FACSDiva 5.0.2 | 3.0 | **`SPILL`** | 13×13 | detector (`B515-A`, `G560-A`, `V450-A`) | raw |

Verified but **not** added, with reasons under [Rejected sources](#rejected-sources):

| File | Instrument | Keyword | Matrix | Notable |
|---|---|---|---|---|
| `flowWorkspaceData` `diva/124500.fcs` | FACSCantoII / Diva 6.1.3 | `SPILL` | 8×8 | fluorochrome-named channels (`FITC-A`, `PE-A`, `Bd Horizon V450-A`) |
| `flowWorkspaceData` `CytoTrol_CytoTrol_1/2.fcs` | LSRII / Diva 6.1.3 | `SPILL` | 7×7 | detector-named |
| `flowWorkspaceData` `a2004_O1T2pb05i_A1/A2` | LSRII / Diva 5.0.2 | `SPILL` | 8×8 **identity** | acquisition wrote a matrix but applied none |
| `CytoML` `cytobank_experiment.acs` | — | `SPILL` | 7×7 | byte-identical copy of `CytoTrol_CytoTrol_1.fcs` |

PeacoQC also ships `111_Comp_Trans.fcs`, the same sample already compensated. It is added separately with its analysis in the pre-compensated signal work, since it exists to demonstrate a detection gap rather than to provide matrix coverage.

## Keyword variant coverage

`SPILLOVER_KEYS` has six entries. Real-file coverage after this pass:

| Variant | Redistributable example | Notes |
|---|---|---|
| `SPILL` | **yes** — `peacoqc-111-raw`, plus 5 more in flowWorkspaceData | The BD FACSDiva FCS3.0 convention. Every real matrix found in this survey used it. |
| `$SPILLOVER` | **no** | The FCS 3.1 standard spelling. No FCS 3.1 file surfaced in any Bioconductor package surveyed; all extdata is FCS 2.0/3.0. |
| `SPILLOVER` | no | — |
| `$SPILL` | no | — |
| `$COMP` / `COMP` | no | Older vendor spellings. |

**Worth acting on.** Five of six parser branches are covered only by synthetic keywords. The parse logic is shared and the variants differ only in keyword name, so this is not necessarily a defect — but `$SPILLOVER`, the spelling the FCS 3.1 *standard* specifies, has never been exercised against a real instrument file here. Closing it needs an FCS 3.1 source, which means a repository with per-dataset terms (FlowRepository, Cytobank) rather than a Bioconductor package.

## Redistribution: can `flowcore-comp-060909.001.fcs` be vendored?

**Legally yes. In practice no, and it is now moot.**

- flowCore is **Artistic-2.0**, which permits redistribution with attribution, so vendoring would be allowed.
- Fetch-on-demand is still better: `.gitignore` already excludes `testdata/fixtures/downloaded/`, `package.json`'s `files` ships only `manifest.json`, and `scripts/fetch-fcs-fixtures.mjs` already caches and extracts. Vendoring grows the repo and the npm tarball for no benefit.
- Moot because the file has no spillover matrix and cannot serve the purpose the plan assigned it.

Recommendation: **keep fetch-on-demand**, and keep the file, reclassified as a control fixture.

## Licensing of added fixtures

`peacoqc-111-raw` comes from PeacoQC, **GPL (>= 3)**. This project is now **MIT** (`5b4d10d`).

That combination is fine as long as nothing changes: the fixture is fetched at test time, gitignored, and excluded from the npm tarball, so the project never redistributes it, and using a file as test input does not create a derivative work of it.

The MIT relicense makes the no-vendoring rule **more** important, not less. Copying GPL-3 data into an MIT-licensed repository would ship copyleft material under a permissive licence. If anyone proposes vendoring a fixture, that needs a real licence review — the current arrangement sidesteps the question entirely, and should stay that way.

## Rejected sources

**`flowWorkspaceData` (GPL-2, 71 MB).** The richest corpus found — six FCS files with `SPILL`, including both edge cases below. Rejected because the tarball is 71 MB to obtain a 1.1 MB file, and because GPL-2-only is the most restrictive licence encountered, which would permanently foreclose vendoring. PeacoQC gives equivalent coverage at 1.5 MB.

Two cases from it are worth fixtures later, from another source if one appears:

- **Identity matrix** (`a2004_*`): acquisition wrote an 8×8 identity `SPILL`. It is discovered like any other matrix and offered as a suggestion, so "a matrix exists" and "compensation is needed" are not the same claim, and nothing currently distinguishes them.
- **Fluorochrome-named channels with a real matrix** (`diva/124500.fcs`): trips the weak fluorochrome-name signal on a conventional file.

**`CytoML` (AGPL-3, 8.1 MB).** Its `cytobank_experiment.acs` FCS is byte-identical to flowWorkspaceData's `CytoTrol_CytoTrol_1.fcs`. No new evidence. Its Gating-ML 2.0 XML matters for FlowJo interop work, not here.

**`flowStats`, `flowAI`, `flowGate`.** No FCS with spillover keywords. `flowGate` (MIT) has FCS but no matrices.

**FlowRepository.** The `/list` API rejects unauthenticated clients. Access needs a registered token and per-dataset terms vary. It is the most likely source of an FCS 3.1 `$SPILLOVER` file, of Cytek Aurora data, and of a FlowJo-exported file — worth obtaining.

## flowCore `compdata`

Found while checking the baseline. `flowCore/inst/extdata/compdata/` contains five FACSCalibur acquisitions (one unstained, four single-stain), a `comp_match` file giving the explicit control-to-channel mapping, and `compref`, the matrix flowCore's own estimator produces from them. That is a complete control-estimation validation set, and it is used in the control-derived compensation work.

## Reproducing

```bash
npm run fixtures:fetch   # honors the manifest; caches tarballs under .datalox/cache
npm test                 # the fixture test now asserts each file's spillover evidence
```

The manifest gained `expected.spilloverKeyword` (a variant name, or `null` to assert *absence*) and `expected.spilloverChannels`. The `null` case is the point: it pins the finding about `flowcore-comp-060909-001` in executable form, so it cannot quietly be adopted as an embedded-matrix baseline again.
