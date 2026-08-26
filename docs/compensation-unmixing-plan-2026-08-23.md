# Flowcyto Compensation and Spectral Unmixing Plan

Date: 2026-08-23

Branch: `feat/flowcyto-compensation-unmixing`

## Decision

Use a separate branch for compensation and unmixing work.

Reason:

- The gate editor contract fixes are host/UI integration work.
- Compensation changes the data semantics used by preview, rendering, and gating.
- Spectral unmixing is a different mathematical problem from conventional compensation.
- A separate branch gives the reviewer a clean boundary for scientific correctness, API shape, and live validation.

## Current State

The current Flowcyto MCP package does not implement compensation.

Repository checks found:

- No compensation implementation in `src/`.
- No compensation tests in `tests/`.
- No compensation commits in the fetched MCP repo history.
- Existing docs mention compensation as missing or out of scope.

Older Datalox code exists under:

```text
C:\Users\fangxf\Research Tools\datalox-1\backend\domains\flow_cytometry\compensation
```

That code is useful as an algorithm reference, but should not be copied wholesale into the MCP package.

Additional source branch checked:

```text
https://github.com/Complexity-LLC/datalox/tree/flowcyto-mcp-tool-loading
commit 9f16c882d2bee5b0b45fd6a8587a6205a589eeef
```

That branch contains the prior Python/Datalox flow-cytometry runtime, including:

- Compensation modules.
- FCS loading modules.
- Gate application and cleanup modules.
- FlowJo export modules.
- Flow cytometry tests.
- A separate Nanocode MCP client/tool-loading implementation.

It does not contain the standalone TypeScript `@datalox/flowcyto-mcp` package architecture used in this repository.

## Definitions

Conventional compensation:

- Corrects fluorescence spillover between a square set of detector channels.
- Uses a square spillover matrix.
- Standard equation:

```text
Xcomp = Xraw * inv(S)
```

The old Datalox implementation computes this as:

```python
np.linalg.solve(S.T, X.T).T
```

Spectral unmixing:

- Estimates fluorochrome abundance from many spectral detector measurements.
- Uses a rectangular reference spectra matrix.
- Solves a constrained least-squares problem, usually NNLS:

```text
minimize ||R * a - measured||^2, subject to a >= 0
```

This is not a direct extension of square compensation.

## PR1 Scope: Deterministic Conventional Compensation

PR1 should support existing FCS spillover metadata and explicit agent-controlled application.

Include:

- Port spillover metadata parsing from old Datalox.
- Store discovered compensation matrices in the workspace.
- Add MCP tools for agent inspection.
- Add explicit compensation selection to preview and plot rendering.
- Add diagnostics when compensation metadata cannot be found or aligned.
- Detect likely pre-compensated channel sets so agents do not double-compensate data.
- Apply compensation at preview-generation time only when requested.
- Add unit tests and live tests against real FCS files.

Exclude:

- Estimating compensation from single-stain controls.
- Spectral unmixing.
- Silent auto-application of discovered matrices.
- UI-only local stabilizations or display-only post-processing.

## Reusable Old Datalox Code

### `parse_spillover_align.py`

Port almost all of this file to TypeScript.

Reference source:

```text
backend/domains/flow_cytometry/compensation/parse_spillover_align.py
```

Reusable pieces:

- Spillover key aliases:

```ts
const SPILLOVER_KEYS = ["$SPILLOVER", "SPILLOVER", "$COMP", "COMP", "$SPILL", "SPILL"];
```

- BD/common FCS format parser:

```text
N,Ch1,Ch2,...,v11,v12,...
```

- CSV-with-header parser:

```text
Ch1,Ch2,Ch3
1,0.02,0.03
0.01,1,0.04
0.02,0.03,1
```

- Channel alignment by normalized detector names.
- Normalization rule:

```ts
function normalizeDetectorToken(value: string): string {
  return value.toLowerCase().replace(/[ _-]/g, "");
}
```

Keep this matching behavior because channel names differ across instruments and exports.

Limit:

- This normalization does not solve semantic instrument renames such as `FL2-A` to `PE-A`.
- PR1 should report those alignment failures with diagnostics instead of guessing.
- If an instrument stores compensation as indexed per-parameter keywords instead of a full TEXT keyword, PR1 should expose the relevant keyword evidence in diagnostics even if it cannot parse the matrix yet.

### `compensation.py`

Port only the deterministic math.

Reference source:

```text
backend/domains/flow_cytometry/compensation/compensation.py
```

Reusable pieces:

- `solve_compensation`
- Matrix diagonal validation.
- Finite numeric validation.
- Pre-compensated channel prefix detection from `split_raw_vs_comp`, adapted into an MCP-native detector.

Do not port into PR1:

- `build_spillover_from_controls`
- `compensation_node`
- Workflow-specific dataframe column mutation.

Reason:

- `build_spillover_from_controls` uses empirical choices such as bright-event percentile, minimum event thresholds, and ridge regularization.
- Those choices need real panel validation before becoming MCP behavior.

### Datalox Workflow Detail Updaters

Do not port.

These files are tied to Datalox runtime graph state and UI detail payloads. The MCP package should expose file-backed, typed tools instead.

## Other Reusable Prior Datalox Areas

### FlowJo WSP Export

Reference source:

```text
backend/domains/flow_cytometry/export/flowjo/__init__.py
backend/domains/flow_cytometry/export/flowjo/mapper.py
backend/domains/flow_cytometry/export/flowjo/package.py
backend/domains/flow_cytometry/export/flowjo/wsp_writer.py
backend/domains/flow_cytometry/export/flowjo/xml_builder.py
backend/domains/flow_cytometry/export/flowjo/validators.py
backend/domains/flow_cytometry/tests/tests_flowjo_export_*.py
```

Prior branch:

```text
https://github.com/Complexity-LLC/datalox/tree/flowcyto-mcp-tool-loading
commit 9f16c882d2bee5b0b45fd6a8587a6205a589eeef
```

That branch contains a FlowJo export path:

```text
build_flowjo_export_ir(...) -> build_flowjo_export_package(...) -> workspace.wsp
```

The package writer creates a deterministic zip containing:

```text
workspace.wsp
manifest.json
annotations.json, optional
sample FCS files, optional portable bundle mode
```

Reusable ideas:

- IR-first export boundary before writing FlowJo XML.
- Strict validation before writing `.wsp`.
- `reference_only` mode for workspaces that point to existing FCS paths.
- `portable_bundle` mode for a zip containing `workspace.wsp` plus sample FCS files.
- FlowJo fixture corpus and expected JSON summaries.
- Compensation matrix export through Gating-ML `spilloverMatrix` nodes.
- Tests for compensated channel names such as `FJComp-*` and FlowJo-compatible `Comp-*` names.

Do not directly port:

- Datalox run-result, population-graph, and artifact-store adapters.
- Program/run/project IDs as required concepts.
- Python package persistence paths under Datalox backend `.local_data`.

For this MCP:

- Add FlowJo export as a separate compatibility PR after PR1 compensation.
- Use `flowcyto.workspace.json` as the source artifact.
- Add an MCP tool such as `export_flowjo_workspace`.
- Tool input should be explicit:

```json
{
  "workspace_path": "path/to/flowcyto.workspace.json",
  "output_path": "optional/path/to/workspace.wsp or export.zip",
  "bundle_mode": "reference_only",
  "sample_uri_mode": "absolute_file_uri"
}
```

- Tool output should include:

```json
{
  "ok": true,
  "wspPath": "path/to/workspace.wsp",
  "bundlePath": "optional/path/to/export.zip",
  "mode": "strict_v0",
  "flowjoCompatibility": {
    "targetVersions": ["10.8.x", "10.9.x", "10.10.x"],
    "warnings": []
  }
}
```

- Keep `.wsp` export one-way from MCP workspace to FlowJo.
- Do not use `.wsp` as the canonical live state.
- Validate the generated `.wsp` structurally and, when possible, by opening it in FlowJo during live validation.

### FCS Loading

Reference source:

```text
backend/domains/flow_cytometry/read_file/read_file.py
backend/domains/flow_cytometry/helpers/helpers.py
```

Reusable ideas:

- Preserve raw FCS TEXT metadata when higher-level readers normalize or omit keywords.
- Enrich channel metadata from `$PnN` and `$PnS`.
- Keep sample assignment metadata separate from loaded event data.
- Keep tests for multi-sample load behavior and sample refs as behavioral references.

Do not directly port:

- Datalox object-store download logic.
- Runtime artifact refs.
- Multi-reader fallback behavior as a silent fallback contract.
- Filename-only control classification as a required compensation contract.

For this MCP:

- Loading remains local-file/workspace based.
- Parsing errors should be structured for agents.
- Metadata extraction should be deterministic and visible in the workspace.

### Gating

Reference source:

```text
gate_application.py
backend/domains/flow_cytometry/gate_preview.py
backend/domains/flow_cytometry/gate_artifacts.py
backend/domains/flow_cytometry/population_graph
```

Reusable ideas:

- Vectorized point-in-polygon behavior.
- Rect, threshold/range, and polygon gate semantics.
- Gate-chain application order.
- Population graph summaries.

Do not directly port:

- Silent empty-data returns for unknown channels.
- Datalox run-result/artifact wiring.
- Workflow-specific preview selection.

For this MCP:

- Invalid gate channels should produce `FlowcytoError`.
- Gate application should stay tied to `flowcyto.workspace.json`.
- Population summaries can become plot-context hints, not automatic gate geometry.

### MCP Tool Loading

Reference source:

```text
packages/nanocode/src/mcp/index.ts
packages/nanocode/src/mcp/client.ts
packages/nanocode/src/mcp/config.ts
packages/nanocode/src/tools/mcp-wrapper.ts
bin/datalox-mcp.js
bin/datalox-pack-mcp.js
```

This branch's commit is about loading configured MCP tools into Nanocode:

```text
9f16c88 Load configured MCP tools in nanocode runtime
```

This is useful as a host-side MCP loading reference, but it is not the Flowcyto MCP server implementation. It should not be merged into the standalone Flowcyto MCP package unless we intentionally add a host/client runtime.

## Proposed Workspace Schema

Current workspace:

```ts
export type FlowcytoWorkspace = {
  version: 1;
  revision: number;
  samples: FlowcytoSample[];
  views: FlowcytoView[];
  gates: WorkspaceGate[];
};
```

Add compensation objects:

```ts
export type CompensationMatrix = {
  id: string;
  name?: string;
  source: "fcs_keyword" | "manual";
  sample?: string;
  keyword?: "$SPILLOVER" | "SPILLOVER" | "$COMP" | "COMP" | "$SPILL" | "SPILL";
  channels: string[];
  // matrix[i][j] = fraction of fluorochrome j spilling into detector i.
  // Apply as Xcomp = Xraw * inv(S), implemented as solve(S.T, Xraw.T).T.
  matrix: number[][];
};

export type CompensationStatus = {
  detectedAsPreCompensated: boolean;
  signals: string[];
  embeddedMatrixFound: boolean;
  suggestedCompensationId?: string;
  recommendation: string;
};

export type FlowcytoWorkspace = {
  version: 1;
  revision: number;
  samples: FlowcytoSample[];
  views: FlowcytoView[];
  gates: WorkspaceGate[];
  compensations?: CompensationMatrix[];
  // Keyed by sampleId. open_fcs returns the status for the opened sample
  // as a flat object (unwrapped from this record for agent convenience).
  compensationStatus?: Record<string, CompensationStatus>;
};
```

Rules:

- `channels.length` must equal `matrix.length`.
- Every matrix row must have `channels.length` values.
- All values must be finite numbers.
- PR1 supports only square matrices.
- Matrix orientation must be documented as conventional spillover matrix `S`, where applying compensation computes `Xraw * inv(S)`.

## Proposed Core Module

Add:

```text
src/core/compensation.ts
```

Functions:

```ts
export function parseSpilloverText(value: string): ParsedCompensationMatrix;

export function extractSpilloverMatrices(
  keywords: Record<string, string>
): CompensationMatrix[];
// ID scheme: "fcs_{normalizedKeyword}_{sampleId}", e.g. "fcs_spillover_s001", "fcs_comp_s001".
// Normalized keyword strips the leading $ and lowercases: "$SPILLOVER" -> "spillover".
// This makes IDs stable across workspace re-opens for the same sample and keyword.

export function detectCompensationStatus(input: {
  keywords: Record<string, string>;
  channels: string[];
  compensations: CompensationMatrix[];
}): CompensationStatus;

export function alignCompensationMatrix(
  compensation: CompensationMatrix,
  availableChannels: string[]
): CompensationMatrix;

export function applyCompensationColumns(input: {
  values: number[][];
  channels: string[];
  compensation: CompensationMatrix;
}): number[][];
```

Implementation notes:

- Use `ml-matrix` for matrix solve instead of handwritten linear algebra.
- Align compensation channels to the intersection of spillover channels and available sample channels.
- The returned `CompensationMatrix` from `alignCompensationMatrix` reflects only the intersection channels and the corresponding submatrix. It does not pad with identities for unmatched channels. `applyCompensationColumns` is responsible for passing through non-intersection channels unchanged.
- Leave channels outside that intersection unchanged.
- Warn when a spillover channel has no matching sample channel.
- Fail with `FlowcytoError` when no channels can be aligned, or when a matrix is singular, non-square, or malformed.
- Do not silently fall back to least-squares in PR1 unless the error contract explicitly says this is acceptable.
- Keep all errors machine-readable for agents.
- Detect likely pre-compensated channels using explicit prefixes such as `FJComp-`, `Comp-`, and `C_` (Scenario A: FlowJo/Summit exports).
- Detect likely pre-unmixed spectral data (Scenario B: Cytek SpectroFlo/Aurora exports) using the `$CYT` keyword. When `$CYT` contains `"Aurora"` or `"CytoFLEX"`, or when channel names match fluorochrome-name patterns (e.g. `"CD3 BUV395"`, `"CD8 FITC"`) rather than detector patterns (e.g. `"V5-A"`, `"B530-A"`), flag as likely pre-unmixed.
- When `embeddedMatrixFound` is `true` but `detectedAsPreCompensated` is `false` (Scenario C: instrument writes compensated data but retains `$SPILLOVER`), the recommendation must still say "confirm whether data was already compensated at acquisition" — `detectedAsPreCompensated: false` does not mean safe to apply; it means the pre-compensation heuristics found no positive signal.
- Treat all pre-compensation detection as a warning/recommendation, not as automatic behavior.

## Agent Guardrails

Update model-facing instructions and tool responses so agents do not leave the MCP contract when compensation is missing.

Add compensation-specific forbidden actions:

```json
[
  "do_not_attempt_compensation_estimation_without_mcp_tools",
  "do_not_run_local_python_for_compensation"
]
```

Agent behavior:

- If no compensation is available, report the returned diagnostics.
- If data appears pre-compensated, ask the user before applying any embedded matrix.
- Do not estimate compensation from controls until `estimate_compensation_from_controls` exists.
- Do not infer semantic channel mappings such as `FL2-A` to `PE-A` without an MCP tool or explicit user mapping.

## Proposed MCP Tools

Add:

```text
list_compensations
get_compensation_matrix
```

`list_compensations` input:

```json
{
  "workspace_path": "path/to/flowcyto.workspace.json",
  "sample_id": "optional"
}
```

`list_compensations` output:

```json
{
  "ok": true,
  "compensations": [
    {
      "id": "fcs_spillover_sample_001",
      "name": "FCS $SPILLOVER",
      "source": "fcs_keyword",
      "sample": "sample_001",
      "channels": ["FITC-A", "PE-A", "APC-A"],
      "keyword": "$SPILLOVER"
    }
  ],
  "nextAction": {
    "tool": "get_compensation_matrix",
    "arguments": {
      "workspace_path": "path/to/flowcyto.workspace.json",
      "compensation_id": "fcs_spillover_sample_001"
    }
  }
}
```

When no compensation is found or no matrix can be parsed, include diagnostics:

```json
{
  "ok": true,
  "compensations": [],
  "diagnostics": {
    "keywordsScanned": ["$SPILLOVER", "SPILLOVER", "$COMP", "COMP", "$SPILL", "SPILL"],
    "keywordsFound": [],
    "unparsedKeywordCandidates": [],
    "availableChannels": ["FSC-A", "SSC-A", "FITC-A", "PE-A"]
  }
}
```

When compensation exists but does not align to the sample channels, include diagnostics:

```json
{
  "ok": true,
  "compensations": [],
  "diagnostics": {
    "keywordsScanned": ["$SPILLOVER", "SPILLOVER", "$COMP", "COMP", "$SPILL", "SPILL"],
    "keywordsFound": ["$SPILLOVER"],
    "availableChannels": ["FSC-A", "SSC-A", "FL2-A"],
    "matrixChannels": ["PE-A"],
    "alignmentWarnings": ["Matrix channel PE-A did not match any available sample channel."]
  }
}
```

`get_compensation_matrix` output:

```json
{
  "ok": true,
  "compensation": {
    "id": "fcs_spillover_sample_001",
    "source": "fcs_keyword",
    "channels": ["FITC-A", "PE-A", "APC-A"],
    "matrix": [[1, 0.02, 0.01], [0.03, 1, 0.04], [0.01, 0.02, 1]]
  }
}
```

Update these tools to accept explicit compensation:

```text
get_event_preview
get_plot_context
render_plot_image
```

Note: the current MCP server exposes `get_event_preview`, and `get_plot_context` is backed by the internal `getEventPreview` function. The `compensation_id` parameter should be supported on the exposed preview/context/image tools and threaded into the internal preview path.

Parameter:

```json
{
  "compensation_id": "optional"
}
```

Rules:

- If omitted, no compensation is applied.
- If provided, the preview path applies the matrix before selecting returned axes.
- The returned preview/context must include:

```json
{
  "compensation": {
    "applied": true,
    "id": "fcs_spillover_sample_001",
    "source": "fcs_keyword",
    "channels": ["FITC-A", "PE-A", "APC-A"]
  }
}
```

## Workspace Creation Behavior

When `open_fcs` creates or refreshes a workspace:

- Parse metadata keywords.
- Extract any recognized spillover matrix.
- Store discovered matrices under `workspace.compensations`.
- Store compensation status under `workspace.compensationStatus`.
- Do not apply them automatically.
- Return a `nextAction` telling the agent that compensation is available.
- Return `suggestedCompensationId` only when exactly one matrix is discovered and the data is not detected as pre-compensated.
- Return diagnostic compensation context even when no matrix is discovered.

Example:

```json
{
  "ok": true,
  "workspacePath": "path/to/flowcyto.workspace.json",
  "compensationSummary": {
    "available": true,
    "count": 1,
    "defaultApplied": false,
    "suggestedCompensationId": "fcs_spillover_sample_001"
  },
  "compensationStatus": {
    "detectedAsPreCompensated": false,
    "signals": [],
    "embeddedMatrixFound": true,
    "suggestedCompensationId": "fcs_spillover_sample_001",
    "recommendation": "One embedded compensation matrix is available. Apply it only when the user or analysis plan requests compensated fluorescence values."
  },
  "nextAction": {
    "tool": "list_compensations",
    "arguments": {
      "workspace_path": "path/to/flowcyto.workspace.json"
    }
  }
}
```

Pre-compensated example:

```json
{
  "ok": true,
  "workspacePath": "path/to/flowcyto.workspace.json",
  "compensationSummary": {
    "available": true,
    "count": 1,
    "defaultApplied": false
  },
  "compensationStatus": {
    "detectedAsPreCompensated": true,
    "signals": ["FJComp-prefixed channels detected"],
    "embeddedMatrixFound": true,
    "recommendation": "Data appears pre-compensated. Applying the embedded matrix may double-compensate the sample."
  }
}
```

## Performance Notes

PR1 should avoid avoidable metadata re-reads when practical:

- Cache parsed FCS keywords and compensation summaries in `flowcyto.workspace.json` during `open_fcs`.
- Let `get_plot_context` and `render_plot_image` accept `compensation_id` directly so agents do not need a separate `list_compensations` call when the id is already known.
- Include `suggestedCompensationId` in `open_fcs` when exactly one matrix is discovered and the data is not detected as pre-compensated.

Follow-on performance work:

- Compact population summaries in plot context, such as largest density cluster centroid and rough spread.
- These summaries must be descriptive hints, not automatic gate geometry.

## Tests for PR1

Unit tests:

- Parses BD/common spillover text.
- Parses CSV-with-header spillover text.
- Rejects malformed spillover text with a structured error.
- Reports diagnostics for unparseable compensation keyword candidates.
- Aligns matrix channels to detector columns using normalized names.
- Partial alignment where spillover channels are a subset of sample channels returns an intersection-aligned matrix.
- Non-fluorescent or out-of-matrix channels pass through unchanged.
- Warns when a spillover channel has no matching sample channel.
- Rejects ambiguous channel alignment.
- Rejects alignment only when no compensation channels match the available sample channels.
- Applies identity matrix without changing values.
- Applies a known 2x2 matrix with expected compensated values.
- Rejects non-square matrices in conventional compensation.
- Detects likely pre-compensated channels with `FJComp-`, `Comp-`, and `C_` prefixes.
- Ports detector-channel recognition cases from prior `tests_detector_channels.py`.

Workspace tests:

- `open_fcs` stores discovered compensation objects from metadata.
- `open_fcs` returns compensation diagnostics when no matrix is found.
- `open_fcs` returns pre-compensated status when prefixed compensated channels are present.
- Workspace validation accepts valid compensation objects.
- Workspace validation rejects malformed matrices.
- `get_event_preview` with no `compensation_id` returns raw values.
- `get_event_preview` with `compensation_id` returns compensated values.
- Preview cache key includes `compensation_id` and compensation matrix content or workspace revision.
- `render_plot_image` reports compensation metadata in its result.

MCP contract tests:

- `list_compensations` returns agent-readable summaries.
- `list_compensations` returns keyword/channel diagnostics when empty.
- `get_compensation_matrix` returns the full matrix.
- Unknown `compensation_id` returns a structured `FlowcytoError`.

Live validation:

- Use at least one conventional FCS with embedded `$SPILLOVER` or `$SPILL`. Candidate baseline: Bioconductor flowCore compensation extdata file `flowcore-comp-060909.001.fcs`. This file is not currently present in `testdata/fixtures`; PR1 should add a small redistributable fixture or document the exact fetch step before using it in tests.
- Render the same marker pair with and without compensation.
- Confirm the compensation metadata appears in `render_plot_image`.
- Confirm repeated renders are deterministic for the same workspace revision and compensation id.

## PR2 Scope: Estimate Conventional Compensation from Controls

PR2 may port `build_spillover_from_controls` after validation.

Inputs needed:

- Experimental sample.
- Unstained control.
- Single-stain controls.
- Explicit mapping from control files to detector/fluorochrome channels.

Proposed MCP tools:

```text
estimate_compensation_from_controls
upsert_compensation_matrix
```

Do not infer control mappings from filenames as the only mechanism. Filename mapping can be an agent helper, but the final tool call should carry explicit mappings.

Validation requirements:

- Test bright controls.
- Test dim controls.
- Test tandem dye spillover.
- Test insufficient events.
- Test missing or ambiguous channel mappings.

## PR3 Scope: Spectral Unmixing

Spectral unmixing should be a separate track.

Reason:

- The matrix is rectangular.
- The solve method is NNLS, not inverse of a square spillover matrix.
- Autofluorescence may be modeled as an additional component.
- Reference spectra should come from controls or trusted references, not conventional FCS spillover metadata.

Proposed module:

```text
src/core/unmixing.ts
```

Core type:

```ts
export type SpectralReferenceMatrix = {
  id: string;
  source: "controls" | "manual";
  detectors: string[];
  components: string[];
  matrix: number[][];
  autofluorescenceComponent?: string;
};
```

Algorithm:

- Use NNLS.
- Prefer a pure TypeScript active-set solver unless a small, maintained dependency is clearly better.
- Do not use square compensation code for spectral data.

### Scientific Library Boundary

NNLS for spectral unmixing is simple enough to implement in pure TypeScript (active-set algorithm, small matrix sizes, no external dependency required).

If future work needs libraries with no viable TypeScript equivalent — FlowSOM clustering, scanpy high-dimensional analysis, scipy's more advanced solvers — the correct pattern is a **Python sidecar process**:

- The TypeScript MCP server remains the MCP contract owner.
- For compute steps that need Python, the server spawns a Python subprocess over stdio and passes/receives JSON.
- This keeps the MCP protocol, workspace format, and tool definitions in TypeScript.
- Do not replace the TypeScript server with a Python MCP server.

This boundary applies to PR3 and all future PRs. Do not introduce a Python sidecar unless a specific computation has no viable TypeScript solution.

## PR4 Scope: Population Graph

Reference source:

```text
backend/domains/flow_cytometry/population_graph/
backend/domains/flow_cytometry/gate_artifacts.py
```

Population graph provides a hierarchical summary of all gated populations for a sample: event counts, percentage of parent, percentage of total, and the gate chain that produced each node.

Include:

- Compute population statistics after gate application (count, parent %, total %).
- Return population graph as a structured result from a new MCP tool.
- Support multi-level gate hierarchies (children of children).
- Include ungated root population as the top node.

Proposed MCP tool:

```text
get_population_graph
```

Input:

```json
{
  "workspace_path": "path/to/flowcyto.workspace.json",
  "sample_id": "optional",
  "compensation_id": "optional"
}
```

Output:

```json
{
  "ok": true,
  "population": {
    "id": "root",
    "name": "All Events",
    "count": 50000,
    "parentPercent": null,
    "totalPercent": 100,
    "children": [
      {
        "id": "gate_lymphocytes",
        "name": "Lymphocytes",
        "count": 32000,
        "parentPercent": 64.0,
        "totalPercent": 64.0,
        "children": []
      }
    ]
  }
}
```

Do not port:

- Datalox artifact wiring or run-result storage.
- Workflow-specific preview selection tied to Datalox graph state.

Population summaries may also be surfaced as compact hints in `get_plot_context` output (largest cluster centroid, rough spread) to improve agent gate placement without constituting automatic gate geometry.

## PR5 Scope: FlowJo Export

Reference source:

```text
backend/domains/flow_cytometry/export/flowjo/
```

FlowJo export writes a `.wsp` workspace file readable by FlowJo and other analysis tools. It is important for labs that gate in this MCP and then hand off to FlowJo for downstream statistics or figure preparation.

Include:

- Generate a valid FlowJo `.wsp` XML file from a `flowcyto.workspace.json`.
- Include all gates (polygon, rect, range) with correct FlowJo gate XML schema.
- Include compensation references if a compensation matrix was applied.
- Record channel names and sample file paths.

Proposed MCP tool:

```text
export_flowjo_workspace
```

Input:

```json
{
  "workspace_path": "path/to/flowcyto.workspace.json",
  "output_path": "path/to/output.wsp",
  "compensation_id": "optional"
}
```

Do not port:

- Datalox object-store upload behavior.
- Compensated-axes FCS re-export (write new FCS files with compensated channel values). This is a separate, larger feature.

Validation:

- Open the generated `.wsp` in FlowJo and confirm gates load correctly.
- Confirm gate geometry matches the source workspace.

## Recommended Branch and PR Sequence

1. `feat/flowcyto-compensation-unmixing`
   - Add this plan document.

2. `feat/flowcyto-conventional-compensation`
   - Implement PR1.

3. `feat/flowcyto-compensation-controls`
   - Implement PR2 only after live validation plan is agreed.

4. `feat/flowcyto-spectral-unmixing`
   - Implement PR3 with NNLS and separate spectral tests.
   - Revisit Python sidecar pattern only if NNLS or reference-matrix work requires scipy.

5. `feat/flowcyto-population-graph`
   - Implement PR4 after gate application is stable and compensation is in place.

6. `feat/flowcyto-flowjo-export`
   - Implement PR5. Requires stable gate schema and compensation references.
   - Validate by opening generated `.wsp` in FlowJo.

## Acceptance Criteria for PR1

PR1 is complete when:

- The MCP package can discover an embedded FCS spillover matrix.
- An agent can list and inspect that matrix.
- An agent can explicitly render a compensated preview/image by passing `compensation_id`.
- Raw behavior remains unchanged when no compensation is requested.
- Tests pass.
- A live validation doc records real-data behavior and the exact files used.
