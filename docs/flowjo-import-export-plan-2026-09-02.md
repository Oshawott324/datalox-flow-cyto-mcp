# FlowJo Import and Export Plan

Date: 2026-09-02

## Context

FlowJo `.wsp` files are the standard interchange format for flow cytometry analysis. Labs gate
data in FlowJo, share `.wsp` workspaces, and use them as the starting point for statistics and
figure preparation. Supporting `.wsp` in both directions enables:

- **Import**: use expert FlowJo gates as evaluation ground truth for AI gating quality. Parse
  `.wsp` gate geometries, apply them to FCS event data, and compare AI-proposed gates by event
  membership (Jaccard / precision / recall).
- **Export**: hand off gates drawn in the Flowcyto MCP to FlowJo for downstream statistics,
  figure preparation, or collaboration.

The old Datalox branch (`Complexity-LLC/datalox@flowcyto-mcp-tool-loading`) has a prior
Python FlowJo export path (`backend/domains/flow_cytometry/export/flowjo/`). There is no FlowJo
import and no FCSExpress support in that branch or in the current MCP repo.

## Priority Order

1. **FlowJo import first** -- needed for evaluation ground truth. Not available from old branch.
2. **FlowJo export second** -- port the design from old Datalox Python code to TypeScript.
3. **FCSExpress later** -- defer unless there are urgent real files that require it.

---

## PR A: FlowJo .wsp Import

Branch: `feat/flowcyto-flowjo-import`

### Goal

Read a FlowJo `.wsp` workspace file and produce a `flowcyto.workspace.json` (or a diff onto
an existing workspace) so that FlowJo-drawn gates can be:

- Used as evaluation ground truth against AI-proposed gates.
- Viewed and further edited in the compact gate editor.
- Compared in event space (not coordinate space) by applying both gate sets to the same FCS data.

### .wsp File Structure

FlowJo `.wsp` is XML. Relevant sections:

```xml
<Workspace>
  <SampleList>
    <Sample>
      <DataSet uri="file:///path/to/sample.fcs" ... />
      <Graph ... />               <!-- compensation, transforms -->
      <SampleNode name="..." ...>
        <Subpopulations>
          <PolygonGate name="Live" ...>
            <PolygonGate name="CD4+" ...>
              ...
            </PolygonGate>
          </PolygonGate>
        </Subpopulations>
      </SampleNode>
    </Sample>
  </SampleList>
  <CompensationList>
    <Compensation name="...">
      <Channel name="..." ... />
    </Compensation>
  </CompensationList>
</Workspace>
```

### Gate Types to Support

| FlowJo type | Maps to | Notes |
|---|---|---|
| `PolygonGate` | `polygon` | Vertex list in transformed axes |
| `RectangleGate` | `rect` | xMin, xMax, yMin, yMax |
| `EllipsoidGate` | `polygon` | Approximate as polygon hull (8-16 vertices) |
| `RangeGate` / `IntervalGate` | `range` | 1D gate on single axis |
| `QuadrantGate` | four `rect` gates | Split at quadrant coordinates |
| `BooleanGate` | skip for now | AND/OR/NOT combinations; out of scope for PR A |

### Transform Handling

FlowJo vertices are stored in **display space** (post-transform). To import correctly:

1. Parse the axis transform from the `.wsp` (biexp, logicle, linear, log).
2. Convert vertices back to **data space** (raw FCS units) so they apply correctly to raw FCS events.
3. Store in `flowcyto.workspace.json` in data space (consistent with existing gate schema).

This is the most important and most error-prone step. Start with linear and log transforms; add
biexponential/logicle in a follow-up.

### Compensation Handling

FlowJo workspaces reference a named compensation matrix. On import:

- Parse the compensation matrix from `CompensationList`.
- Store it in `workspace.compensations` with `source: "fcs_keyword"` or a new `source: "flowjo_wsp"`.
- Do not automatically apply compensation; follow the same explicit-only contract as PR1.

### MCP Tool

```text
import_flowjo_workspace
```

Input:
```json
{
  "wsp_path": "/path/to/workspace.wsp",
  "workspace_dir": "/path/to/output-workspace",
  "sample_id_map": { "sample.fcs": "sample_001" },
  "overwrite_gates": false
}
```

Output:
```json
{
  "ok": true,
  "workspacePath": "...",
  "samplesImported": 1,
  "gatesImported": 7,
  "compensationsImported": 1,
  "warnings": ["EllipsoidGate approximated as polygon", "BooleanGate skipped"]
}
```

### Evaluation Use Case

Once import works, the evaluation path is:

```text
import_flowjo_workspace (FlowJo gate geometry)
-> apply both gate sets to same FCS events via getEventPreview
-> compare event membership: Jaccard / precision / recall per gate
-> flag low-Jaccard cases for expert review
```

This comparison is automatic and does not require expert annotation for routine cases.

### Scope Limits for PR A

- Support PolygonGate, RectangleGate, RangeGate, QuadrantGate.
- Support linear and log transforms. Biexponential/logicle approximation can follow.
- Do not support BooleanGate, group gates, or statistics nodes.
- Do not write FCS files.
- Do not make import the live state; `flowcyto.workspace.json` remains canonical.

### Known Failure Modes (from prior Datalox FlowJo export experience)

The old Datalox FlowJo export did not work initially and required iteration. Known root causes
that trip up any fresh implementation:

**1. Coordinate space (most common failure)**

FlowJo gate vertices are stored in **display space**, which depends on the axis transform:

| Transform | Display space |
|---|---|
| Linear | Raw FCS channel values (same as data space) |
| Log | `log10(raw)` — e.g. a value of 1000 is stored as `3.0` |
| Biexponential / Logicle | Non-linear mapping; cannot be approximated as log |

For import: parse the transform from the `.wsp`, invert it, convert display coordinates back to
raw FCS values before storing in `flowcyto.workspace.json`.

For export: apply the transform forward, converting raw FCS values to display coordinates before
writing vertices to `.wsp`.

**Start with linear and log only.** Biexponential/logicle require numeric root-finding for the
inverse and should be a follow-up. If a `.wsp` uses biexponential transforms, skip those gates
and emit a warning, rather than importing incorrect coordinates silently.

**2. FlowJo XML schema version**

FlowJo uses Gating-ML 2.0 namespaces but wraps them in FlowJo-specific `<Gate>` elements.
The schema has changed across versions:

- FlowJo 10.x: `<Gate name="..." gating:id="...">` wrapping `<gating:PolygonGate ...>`
- FlowJo 7/X: different element names and attribute layouts

**Target FlowJo 10.x only.** Validate with FlowJo 10.8 or newer. Do not try to support all
versions in PR A or PR B.

**3. Compensation parameter name references**

FlowJo gate dimensions reference compensation by name (`gating:compensation-ref="..."`) which
must exactly match a defined `<CompensationMatrix name="...">`. If the names do not match,
FlowJo silently applies no compensation to those gates.

**4. Gate ID format**

FlowJo expects gate IDs in UUID format. Using arbitrary strings may cause FlowJo to reject or
misbehave when reading the `.wsp`. Generate v4 UUIDs for gate and parent IDs.

**5. Real fixture requirement**

Do not rely on a hand-crafted fixture alone for export validation. Before declaring PR B
merge-ready:

1. Export a reference `.wsp` from FlowJo using the tetramer dataset (export the gated workspace
   to a `.wsp` via File → Export → Workspace).
2. Add that file as `testdata/fixtures/flowjo/reference-flowjo10-export.wsp`.
3. Parse it with the import tool and confirm gate coordinates round-trip correctly.
4. Then generate a new `.wsp` from the same workspace.json and open it in FlowJo to confirm gates
   appear correctly.

The hand-crafted fixtures in `testdata/fixtures/flowjo/` test the parser structure but do NOT
substitute for this live validation step.

### Implementation Notes

- Add `fast-xml-parser` as a dependency (small, ESM-compatible, TypeScript types included).
  It handles namespaced XML without requiring DOM or DOMParser.
- Parse one sample at a time; build gate hierarchy from nested XML `<Subpopulations>`.
- Validate output with `validateWorkspace` before returning `ok: true`.
- Use crypto.randomUUID() for gate IDs on export (available in Node.js 20+).
- See `testdata/fixtures/flowjo/` for hand-crafted fixtures covering the parser structure.

---

## PR B: FlowJo .wsp Export

Branch: `feat/flowcyto-flowjo-export`

### Goal

Write a valid FlowJo `.wsp` workspace file from a `flowcyto.workspace.json` so that labs can
hand off gates to FlowJo for statistics, figure preparation, or sharing.

### Reference Source

Old Datalox branch has a working Python export path:

```text
Complexity-LLC/datalox@flowcyto-mcp-tool-loading
backend/domains/flow_cytometry/export/flowjo/
  mapper.py       -- WorkspaceGate -> FlowJo IR
  xml_builder.py  -- IR -> .wsp XML
  wsp_writer.py   -- write .wsp to disk
  package.py      -- bundle .wsp + FCS files
  validators.py   -- structural validation
```

Port the design to TypeScript. Do not merge the Python code directly. Use `flowcyto.workspace.json`
as the source of truth, not the old Datalox data model.

### Gate Mapping

| Flowcyto type | FlowJo XML |
|---|---|
| `polygon` | `<PolygonGate>` with `<vertex>` elements |
| `rect` | `<RectangleGate>` with `min`/`max` attributes |
| `range` | `<RangeGate>` |

Vertices must be in FlowJo display space (post-transform). If gates were drawn in data space
(raw FCS units), apply the transform before writing vertices.

### Compensation Export

If a compensation was applied to the workspace, write the matrix into the `<CompensationList>`
section and reference it from the sample's `<Graph>` node. Use `compensation_id` to identify
which matrix was in effect.

### MCP Tool

```text
export_flowjo_workspace
```

Input:
```json
{
  "workspace_path": "/path/to/flowcyto.workspace.json",
  "output_path": "/path/to/output.wsp",
  "compensation_id": "fcs_spillover_sample_001",
  "bundle_mode": "reference_only"
}
```

`bundle_mode`:
- `"reference_only"`: write only `.wsp`, FCS file paths stay absolute.
- `"portable_bundle"`: write a zip with `.wsp` + FCS files (for sharing).

Output:
```json
{
  "ok": true,
  "wspPath": "...",
  "bundlePath": null,
  "gatesExported": 7,
  "compensationExported": true
}
```

### Known Failure Modes for Export

Same coordinate-space issue applies in reverse: vertices in `flowcyto.workspace.json` are in
raw FCS data space. Before writing to `.wsp`, apply the axis transform so FlowJo reads them
in display space. For linear axes (FSC/SSC drawn in the compact editor) this is a no-op. For
fluorescence channels on log/biexp axes, the conversion is required.

**The export path that failed in old Datalox was most likely the coordinate transform step.**
The old code eventually handled this; the key is to apply it per-axis, not per-gate, since the
same gate can span a linear X axis and a biexp Y axis.

For compensation references on export: write `gating:compensation-ref="uncompensated"` for
FSC/SSC (linear) gates. For fluorescence gates, reference the compensation matrix by name. If
the workspace has no applied compensation, emit `gating:compensation-ref="uncompensated"` for
all dimensions.

### Reusable Ideas from Old Branch

- IR-first boundary: convert `WorkspaceGate` -> intermediate representation, then IR -> XML.
  This decouples the domain model from the XML writer.
- Strict validation before writing: confirm all gate IDs are unique, all required fields present.
- `portable_bundle` zip mode (copy FCS files alongside `.wsp`).
- Compensation matrix export through FlowJo `spilloverMatrix` nodes.
- Test fixture: generate a `.wsp`, read it back in FlowJo or with the import tool, confirm round-trip.

Do not port:
- Object-store upload behavior.
- Compensated-FCS re-export (write new FCS files with compensated values) -- separate larger feature.
- Old Datalox sample or workspace models.

### Scope Limits for PR B

- Export polygon, rect, range gates.
- Export compensation matrix reference if one was applied.
- `reference_only` bundle mode only; portable bundle can follow.
- Do not import `.wsp`; that is PR A.
- Do not write compensated FCS files.
- Validate the generated `.wsp` by opening it in FlowJo during live validation.

---

## FCSExpress

Defer until there are urgent real files that require it. FCSExpress has no open XML spec; reverse
engineering its format is expensive. If needed later, start with a read-only import of a single
gate type.

---

## Sequencing Relative to Other PRs

| PR | Branch | Depends on |
|---|---|---|
| A: FlowJo import | `feat/flowcyto-flowjo-import` | main (gate schema stable) |
| B: FlowJo export | `feat/flowcyto-flowjo-export` | PR A (round-trip test) or independent |
| Spectral unmixing | PR4 from original plan | PR1 compensation (done) |
| Population graph | PR3 from original plan | stable gate schema |

PR A and PR B can be developed in parallel since they touch different code paths. If round-trip
testing (import -> edit -> export) is a goal, merge A before B.
