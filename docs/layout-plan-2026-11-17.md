# Layout Plan: Gating Strategy, Sample Comparison, and FlowJo Layout Interop

Date: 2026-11-17 (revised 2026-11-18 after review)

Authors: Fang Xie, Yifan Jin

## Parameter-aware rendering update (2026-11-21)

This supersedes the temporary transform/bounds blocker described in the earlier review below.
`configurePlotAxes` now applies each panel's scale, transform parameters and data-space bounds.
Bounds groups supply the common mapping and extent. Events, gate overlays and tick labels share
the same forward/inverse functions; explicit bounds are not padded or auto-fitted.
Arcsinh requires its explicit cofactor; biex uses the existing validated reference spline table.
An unrepresented biex parameter set remains a typed `unsupported_flowjo_biex_parameters` failure,
never an approximation with default parameters. The synthetic import fixture intentionally includes
such a set (pos=4.3), while the real tetramer parameters are covered by the reference table.

Preview membership, compensation and deterministic sampling still use the existing preview
pipeline. Preview caches remain data-space artifacts: changing presentation parameters does not
change their identity or mutate them. Density bins remain the existing uniform data-space bins,
whose boundaries are transformed for display; they are not newly binned uniformly in display
space. This distinction matters when assessing density appearance against another application.
Nonpositive log events are outside the log display domain; invalid gate vertices are reported,
not rendered at invented coordinates. No population counts change when only bounds change.

The live-render script again requires six strategy plots and three comparison plots plus two
missing-sample placeholders. `layout_transform_rendering` is no longer a known gap.
**Independent FlowJo visual and event-membership validation remains pending.** Numeric tests,
reference spline checks and standalone comparisons are not evidence of vendor equivalence.

## Verified defect: axis rescale is not applied (2026-11-21)

Parameter-aware rendering works — the imported biex parameters demonstrably drive the mapping —
but the rendered panels are still wrong, for a separate reason found while verifying it.

Evidence from the reference workspace, panel `Layout-1_panel_1`, channel `APC (Allophycocyanin)-A`:

| Quantity | Value |
|---|---|
| `$PnR` (FCS data range) | 2147483647 |
| biex `maxRange` parameter | 214748 |
| event median, raw | 8.12e7 |
| event median, compensated | 8.16e7 |
| events above `maxRange` | 249 / 249 (100%) |
| `forward(maxRange)` | 257.0 (the biex display ceiling) |
| computed `visualBounds.x` | −528 .. 47331 |
| axis fraction holding data up to `maxRange` | 1.64% |

Compensation is not the cause: raw and compensated medians agree to three digits and the matrix is
near-identity. The cause is a missing domain rescale. The workspace's `<Cytometer>` declares:

```xml
<Cytometer name="YETI" widthBasis="-10" linMin="0" linMax="214748" logMax="214748"
           linearRescale="10000" logRescale="10000" transformType="BIEX" .../>
```

FlowJo divides FCS values by 10000 before applying a transform whose `maxRange` is 214748, so
2147483647 / 10000 = 214748 maps exactly onto the transform ceiling. `flowJoTransformContext`
already reads `linearRescale` and uses it for gate coordinate conversion, but the layout axis path
(`buildPanelAxisMapping`) feeds raw data values straight into the biex transform. Every event
therefore lands about 10^4 too far along the axis, auto-bounds expand to roughly 47000 biex units
instead of 0..257, and the entire population is compressed into the bottom ~1.6% of the plot.

`forward(8.16e7 / 10000) = forward(8160) ≈ 175`, which sits mid-range as expected, so the rescale
fully accounts for the discrepancy.

Fix outline: carry the per-cytometer rescale into the imported axis configuration and apply it
inside the axis mapping, so events, gate overlays, bounds and tick labels all share it. Linear
axes are visually unaffected because a uniform factor is absorbed by auto-bounds, but their tick
labels are wrong by the same factor and must be corrected too.

Until this lands, the six strategy panels and three comparison panels render, but their axis
domains do not match FlowJo and a visual comparison will not be meaningful. This is tracked as the
`axis_domain_rescale_not_applied` entry in the live script's `knownGaps`.

Found without FlowJo, by checking the transform parameter domain against the data range. It is the
kind of defect the pending vendor comparison is meant to catch, and it would have dominated that
comparison had it not been found first.

## Renderer review and L3 start (2026-11-21)

Review of `d7e4e865` found a rendering correctness gap, not only pending vendor validation:
`renderLayout` never passed `PanelAxis.scale`, `transform`, `bounds` or `boundsGroup` to the
preview pipeline. Its test named for imported biex parameters only checked that a scale existed.
Standalone equivalence therefore proved agreement between two calls omitting the same settings.

Until parameter-aware rendering is implemented, explicit transforms/bounds produce
`layout_axis_configuration_not_supported` placeholders, and scale disagreements produce
`layout_scale_mismatch`. This intentionally withdraws the earlier claim that all nine bound
reference panels render faithfully.

The live-render acceptance script asserts what the renderer does **today** rather than holding a
failing 6/6 and 3/5 target, because a permanently red script cannot distinguish a known gap from a
new regression. The gap is asserted instead of merely aspired to: each panel carrying imported
transform parameters must be *blocked*, so a silent fallback to preview defaults now fails the
script in either direction. What remains missing is recorded in its `knownGaps` output:

| Gap | State |
|---|---|
| `layout_transform_rendering` | 6 reference panels carry biex parameters the renderer does not apply |
| `flowjo_equivalence_unverified` | No panel compared against FlowJo's own rendering |

Independent FlowJo screenshots and event-membership validation are also still pending.

Other review fixes:

- Layout panels pass deterministic unique clip IDs to the shared SVG renderer.
- `compensation="none"` means no additional compensation, not raw data. If a source records a
  matrix, disabling it produces a `compensation_space_mismatch` placeholder rather than evaluating
  its gates in a different coordinate space. No invalid counts are returned for that panel.
- Render results retain `pageCanvas` separately from the expanded image `viewport`, including
  negative coordinates. Rendering never mutates stored page geometry.

Initial L3 slice: read-only `suggest_gating_strategy_layout` and `suggest_comparison_layout`.
Strategy panels retain each gate's actual parent and axes; compensation is explicit, never inferred.
Comparison inputs provide source and axis objects per panel, permitting heterogeneous nodes and
ragged `by_sample` rows; grid preserves input order. Proposals return validation diagnostics and
the expected workspace revision for a later explicit `upsert_layout`. They do not save anything.
`linear` is initially a vertical sequence in workspace gate order; `tree` arranges depth rows.
Automatic shared bounds, `by_node`, and richer tree placement are deferred, not claimed complete.
Generators do not infer scale/transform parameters: omitted settings use the existing preview
defaults; supplied settings are preserved and the renderer reports its current limitations.

## Goal

Make **layout** a first-class concept in the Flowcyto MCP workspace, covering:

1. **Gating strategy view** — the hierarchy rendered as a sequence of plots, each showing a parent
   population with its child gate drawn.
2. **Side-by-side sample comparison** — a grid of panels across samples, where different samples
   may show *different* gates/nodes, on verifiably matched axes.
3. **Layout import/export with FlowJo `.wsp`** — round-trip the FlowJo Layout Editor.

## Why now

Everything downstream of gating (figures, QC review, batch comparison) is a layout problem, and
the current workspace has no layout concept. `FlowcytoView` holds a single
`{sample, parent, x, y, scale}` per sample — enough to restore one plot, not to arrange many.

Layout is also the biggest remaining FlowJo interop gap. `import_flowjo_workspace` and
`export_flowjo_workspace` handle gates, compensation and per-node `Graph` axes, but skip
`<Layout>` entirely.

---

## Evidence base and its limits

Observations below come from one real file: `20211130 BDC Tet.wsp` (FlowJo 10.8, 12 samples,
571 KB). **One complex workspace is weak evidence for serialization rules.** It shows what FlowJo
wrote for one history of edits; it does not show which attributes are required, which are
defaults, or how FlowJo responds to a change. Everything marked **[hypothesis]** below must be
settled by the controlled-change experiments in the next section before it is implemented.

### Confirmed by direct inspection

**Layout structure:**

```xml
<Layout name="gating" outputFile="file:/..." showGrid="0" scale="0.33">
  <PrintLayout rows="1" columns="1" padding="36" orientation="1" width="612" height="792"
               imageableX="72" imageableY="72" imageableWidth="468" imageableHeight="648"/>
  <PageSection sectionName="header">...HTML...</PageSection>
  <Iteration iterationType="OFF" iterationValue="18" iterationKeyword="" groupName="Samples"/>
  <BatchSettings useCurrentGroup="1" order="ACROSS" direction="COLUMNS" destination="toLayout"/>
  <FigList>
    <ChartData x="95" y="65" width="256" height="256"
               showSampleName="1" showFullPath="1" showFreq="0" showCount="1"
               showPopulationName="1" useShortName="1" z="0">
      <Graph type="Pseudocolor" heatMapStatParameter="Comp-FL03-A">
        <Axis dimension="x" name="FS00-A" label="" auto="auto"/>
        <Axis dimension="y" name="SS02-A" label="" auto="auto"/>
        <GraphSettings level="5%" graphResolution="256" dotsToDraw="8000" .../>
        <GraphEnvironment showGrid="0" showAxes="tnlTNL" showGates="1" .../>
      </Graph>
      <Ancestry backgating="0" horizontal="0"/>
      <Multigraph type="NONE" displayType="DotPlot" rows="0" columns="0"/>
      <PopModelList>
        <DataLayer path="Lymphocytes/Single Cells/Live CD3+/CD4+" sampleID="19" sampleGMID="1">
          <LegendSpec color="#000000" chartFill="le.chartfill.tinted.40" control="0"/>
        </DataLayer>
      </PopModelList>
      <WindowPosition x="95" y="65" width="256" height="256" displayed="1"/>
    </ChartData>
    <FigColorLegend x="36" y="353" width="70" height="12" colorMapName="Default (blue,green,yellow,red)"/>
  </FigList>
</Layout>
```

**Both target features already exist in this file.**

Gating strategy — six panels, all `sampleID="19"`, descending the hierarchy:

```
path=""                                                    (root)
path="Lymphocytes"
path="Lymphocytes/Single Cells"
path="Lymphocytes/Single Cells/Single Cells"
path="Lymphocytes/Single Cells/Single Cells/Live CD3+"
path="Lymphocytes/Single Cells/Single Cells/Live CD3+/CD4+"
```

Sample comparison — five panels, same path, different samples:

```
path=".../Live CD3+/CD4+"  sampleID="19"   (B1 44 1-1.fcs)
path=".../Live CD3+/CD4+"  sampleID="1"    (C1 45 1-1.fcs)
path=".../Live CD3+/CD4+"  sampleID="2"
path=".../Live CD3+/CD4+"  sampleID="20"
path=".../Live CD3+/CD4+"  sampleID="18"   (A12 FMO Tet.fcs)
```

**Populations are referenced by slash-delimited gate *name* path**, not by ID. Root is `""`.
Our gates are referenced by `id` with a `parent` chain, so both directions need a resolver. This
is the single largest correctness risk in the whole plan.

**Repeated names at different depths are real**: `Single Cells/Single Cells` occurs within one
sample. Across the file, "Single Cells" appears 16 times, "CD4+" and "Lymphocytes" 8 times each,
over 12 samples.

**No population name in this file contains `/`** (0 of 64).

**No axis in this file carries explicit bounds.** All 180 `<Axis>` elements are `auto="auto"`,
except 4 histogram y-axes at `auto="modal"`. Where FlowJo stores a manually set axis range is
therefore **unknown**, not merely unmodelled.

### Explicitly unresolved

| Question | Status |
|---|---|
| Where explicit axis bounds are stored | Unknown — no non-auto axis in the sample file |
| Whether `/` in a gate name is escapable, and how | Unknown — no such name exists in the sample file |
| Whether `figID` format matters to FlowJo on read | **[hypothesis]** — format observed, requirement untested |
| How `sampleGMID` is assigned, and whether it is required | **[hypothesis]** — values observed, rule unknown |
| Units and origin of `ChartData x/y` vs `PrintLayout` page coords | **[hypothesis]** — pixel-like, untested |
| Whether `ChartData` and `WindowPosition` must agree | **Answered during L4: they do not.** In the comparison layout every `ChartData` carries `width="0" height="0"` while its direct-child `WindowPosition` holds the real 256×256 size. `ChartData` width/height are therefore not authoritative; the panel's own `WindowPosition` is the fallback. Nested `WindowPosition` elements belong to `Ancestry`/`Multigraph` and must not be read as panel geometry. E1 should still establish which one FlowJo writes on a move. |

---

## Controlled-change experiments (prerequisite for L4/L5)

This is the methodological borrowing from craft-anything and rea: rather than infer rules from one
complex artifact, make one change at a time and diff. No binary analysis is needed.

Protocol: in FlowJo 10.8, build a minimal baseline, then apply exactly one change per saved copy.
Use the tetramer dataset. Diff each file against the baseline with XML-aware comparison.

| ID | Change from baseline | Resolves |
|---|---|---|
| E0 | Baseline: one layout, one panel, root population, FSC-A/SSC-A | Minimum required attribute set |
| E1 | Move that panel only | Which attributes encode position; whether `ChartData` and `WindowPosition` both move; units |
| E2 | Change the panel's population to a gated node | `DataLayer path` format; whether `figID` is stable across edits |
| E3 | Add a second sample as an overlay in the same panel | `PopModelList` multiplicity; `LegendSpec` defaults; how `sampleGMID` is assigned |
| E4 | Duplicate the panel for a second sample, side by side | Comparison encoding; whether `Iteration`/`BatchSettings` are touched |
| E5 | Set an explicit axis range on one panel | **Where axis bounds live** — blocks the bounds design below |
| E6 | Rename a gate referenced by a panel | Confirms name-path storage; shows whether anything caches the old name |
| E7 | Name a gate with a `/` in it, if FlowJo permits | Whether escaping exists at all, and its form |

E5 and E7 gate specific design decisions and are not optional. E0–E4 and E6 gate the export
identifier and geometry decisions.

Record results in `docs/flowjo-layout-serialization-2026-11-XX.md` with the diffs inline. Commit
the synthetic baseline `.wsp` files produced here as fixtures; do not commit the tetramer-derived
ones.

---

## Part 1 — Layout in the workspace schema

### Types (`src/core/types.ts`)

```ts
export type AxisBounds = { min: number; max: number };   // data space

export type PanelAxis = {
  channel: string;
  scale?: AxisScale;
  bounds?: AxisBounds;      // explicit range; omit for auto
  boundsGroup?: string;     // id of an AxisBoundsGroup this axis follows
};

export type LayoutPanelSource = {
  sample: string;           // Flowcyto sample id
  parent: string;           // gate id whose population is plotted, or "root"
  gate?: string;            // optional child gate id to draw on top
  compensationId?: string;  // per-source and explicit; see Part 1c
  legend?: { color?: string; label?: string };
};

export type PanelStatus =
  | { state: "resolved" }
  | {
      state: "unresolved";
      reason:
        | "ambiguous_path"
        | "unknown_path"
        | "unknown_sample"
        | "unsupported_name"       // e.g. a name containing "/"
        | "unsupported_feature";   // Multigraph expansion, backgating, iteration
      detail: string;
      candidates?: string[];       // gate ids, for ambiguous_path
    };

export type LayoutPanel = {
  id: string;
  sources: LayoutPanelSource[];   // more than one = overlay
  x: PanelAxis;
  y?: PanelAxis;                  // omit for a histogram
  plotType?: "pseudocolor" | "dot" | "contour" | "histogram";
  position: { x: number; y: number; width: number; height: number };
  title?: string;
  show?: { sampleName?: boolean; populationName?: boolean; count?: boolean; freq?: boolean };
  status: PanelStatus;            // required
  _flowjo?: Record<string, unknown>;  // presentation-only; see Part 3b
};

export type AxisBoundsGroup = {
  id: string;
  channel: string;     // every member axis must resolve to this channel
  scale: AxisScale;    // every member axis must use this scale
  bounds: AxisBounds;
};

export type FlowcytoLayout = {
  id: string;
  name: string;
  kind: "gating_strategy" | "comparison" | "freeform";
  canvas: { width: number; height: number };
  panels: LayoutPanel[];
  boundsGroups?: AxisBoundsGroup[];
  source?: "generated" | "flowjo_wsp" | "manual";
  _flowjo?: Record<string, unknown>;
};

export type FlowcytoWorkspace = {
  // ...existing fields
  layouts?: FlowcytoLayout[];
};
```

Notes:

- `sources` is an array from the start, so overlay and comparison are one primitive and FlowJo's
  `PopModelList` maps directly onto it.
- `status` is **required**, not optional. A panel that cannot be resolved stays in the layout and
  stays visibly unresolved. Nothing is dropped silently.
- `position` is absolute, matching FlowJo. Generators compute it; humans and agents rarely set it.
- Layout writes go through `upsert_layout` with `expected_revision`, same revision-safe contract
  as `upsert_gate`.

### 1a. Path resolver (`src/core/gate-path.ts`)

Shared by import and export, and the main correctness risk. **Strictly scoped to one sample** —
a path is only ever resolved against gates whose `sample` matches.

```ts
export type PathResolution =
  | { status: "resolved"; gateId: string }
  | { status: "unknown_sample"; sampleId: string }
  | { status: "ambiguous"; candidates: string[]; atSegment: string; depth: number }
  | { status: "not_found"; atSegment: string; depth: number }
  | { status: "unsupported_name"; atSegment: string; depth: number };

export function namePathToGateId(workspace, sampleId, path): PathResolution;

export type PathEncoding =
  | { status: "ok"; path: string }
  | { status: "unknown_sample"; sampleId: string }
  | { status: "unknown_gate" | "cycle"; gateId: string }
  | { status: "unsupported_name"; gateId: string; name: string }
  | { status: "ambiguous"; candidates: string[]; atSegment: string; depth: number };

export function gateIdToNamePath(workspace, sampleId, gateId): PathEncoding;
```

Rules:

- Segments are gate `name`, falling back to `id` when unnamed, joined by `/`. Root is `""`.
- Resolution walks down from root, matching children by name at each depth, scoped to the sample.
- **Ambiguity is never auto-resolved.** Two siblings sharing a name return `ambiguous` with all
  candidate gate ids. The caller records an unresolved panel. Repeated names at *different depths*
  are normal and resolve fine, since matching is per-level.
- **No escaping is invented.** A name containing `/` returns `unsupported_name` in both
  directions until experiment E7 establishes what FlowJo actually does. Export refuses such a
  panel and reports it rather than emitting a path that may be misread.
- Never throws. Every failure is a typed result the caller turns into a `PanelStatus`.
- Reverse encoding also checks path ambiguity; it must not emit a path that cannot resolve back
  uniquely. Missing parents and cyclic parent chains are typed errors, not infinite traversal.
- Quadrant populations participate at their container's parent level, matching the existing
  population graph. The quadrant container itself is not a population path segment.
- Empty names are unsupported; only absent names use the ID. No trimming or case folding is
  applied. Slash-containing names that collide with a nested path also fail explicitly.

### 1b. Axis bounds and comparison groups

Scale type alone does not make two panels comparable — identical transforms over different ranges
still mislead. Panels therefore carry explicit `bounds`, and `AxisBoundsGroup` lets several panels
share one range.

Validation runs in two passes, both inside `validateWorkspaceObject` so there is one write path.
The split matters: a check that needs FCS metadata must not be approximated by string equality at
storage time, because a layout rejected on write never reaches a renderer that could reconcile it.

**Structural pass** — no metadata required. Validates references (sample, population, gate,
compensation id), panel geometry, bounds well-formedness, bounds-group ids, and scale and
transform agreement with the group. Scale and transform are compared here because that is pure
data comparison.

**Metadata-aware pass** — uses the `metadataBySample` map already loaded for gate parameter
checks. Resolves each axis `channel` in every sample the panel actually plots, matching `$PnN`
name first and then `$PnS` marker and detector aliases, mirroring the precedence used by
compensation alignment. Then:

- An axis channel that resolves in no sample parameter is `unknown_parameter`, naming the sample.
- Bounds-group membership is checked on **resolved parameter identity**, not string equality, so
  `FL03-A` and `FITC-A` may share a group when the FCS metadata says they are one parameter, and
  are rejected when they are not.
- Skipped entirely when metadata could not be loaded; `sample_metadata_failed` already blocks that
  write, so nothing is silently accepted.

**Transform parameters.** A matching `AxisScale` name is not sufficient under `biex` or `arcsinh`,
where parameters change the mapping. `PanelAxis.transform` and `AxisBoundsGroup.transform` carry
those parameters, and a group under a parameterized scale requires both the group and every member
axis to state them and agree. Omitting them is `missing_axis_transform`, not an assumed match.

Panels may sit at **different gate nodes** and still share a group — that is the point: comparing
CD4+ across samples, or parent against child, on one range. Every mismatch is a structured error
naming the panel, axis and conflicting value; nothing is silently rescaled.

Group bounds may be set explicitly, or computed by a helper that takes the union of the data
ranges of member panels, so "matched axes" does not require hand-picking numbers.

**Blocked on E5:** how bounds are written to and read from `.wsp` is unknown. Until E5, bounds are
a Flowcyto-native concept: honoured by our renderers, and on export written only if E5 shows a
faithful mapping. If it does not, export emits auto axes and reports bounds as a known fidelity
loss, per panel.

### 1c. Compensation per source

Compensation is a property of a `LayoutPanelSource`, not of a panel. Overlay sources are often
different samples with different sample-specific matrices, which a single panel-level id cannot
express.

Rendering reports, for every source, what was actually applied:

```ts
type RenderedSourceCompensation = {
  sample: string;
  requestedCompensationId?: string;
  applied: boolean;
  id?: string;
  source?: CompensationMatrix["source"];
  channels?: string[];    // resolved channel mapping actually used
  warnings?: string[];
};
```

Each panel additionally gets a comparability report:

```ts
type PanelComparability = {
  compatible: boolean;
  issues: Array<{
    code: "mixed_compensation_state" | "different_compensation_source"
        | "channel_resolution_mismatch" | "scale_mismatch" | "bounds_mismatch";
    detail: string;
  }>;
};
```

`mixed_compensation_state` — one source compensated and another not — is a real scientific error
in an overlay, and must surface rather than render quietly. The no-silent-compensation contract
from PR1 is unchanged: nothing is applied without an explicit id.

---

## Part 2 — Generators and rendering

Deterministic and read-only. Each returns a `FlowcytoLayout` the caller may store with
`upsert_layout`. Neither writes the workspace by itself.

### 2a. Rendering (built first, against imported layouts)

`render_layout_image(workspace_path, layout_id, options?)` composites panels with the existing
`plot-image.ts` renderer into one SVG, positioned per `panel.position`, written under
`.datalox/cache/layouts/`. Unresolved panels render as a labelled placeholder carrying the status
reason, so a partial import is visibly partial rather than quietly missing plots.

`render_layout(workspace_path, layout_id)` returns the agent-readable equivalent. For large
layouts it returns a panel summary first, with per-panel bins fetched on demand, rather than
dozens of full bin grids in one response. Panel count is capped (default 64) with a structured
error above it.

Both report `RenderedSourceCompensation` per source and `PanelComparability` per panel.

### 2b. Gating strategy generator

`suggest_gating_strategy_layout(workspace_path, sample_id, options?)` walks the gate tree for one
sample, emitting one panel per gate node showing the **parent** population with the **child** gate
drawn — how a gating strategy figure is read. Panel axes come from the gate's own `x`/`y`, reusing
the `axesForParentContext` logic already in the gate editor.

| `arrangement` | Shape |
|---|---|
| `"linear"` (default) | One row per depth, left to right; follows the main chain |
| `"tree"` | Siblings spread horizontally, depth downward; branches visible |

Default panel size 256×256 with 24 px gutters, matching the observed file.

### 2c. Comparison generator

`suggest_comparison_layout(workspace_path, panels, options?)` takes an **explicit panel list** of
`{sample, parent, gate?, x?, y?}` — not a samples × nodes product — because different samples may
need different nodes.

| `arrangement` | Shape |
|---|---|
| `"grid"` | `rows` × `columns`, filled in input order |
| `"by_sample"` | One row per sample; columns follow that sample's listed nodes (rows may be ragged) |
| `"by_node"` | One column per node; rows follow samples |

By default the generator creates one `AxisBoundsGroup` per distinct (channel, scale) pair across
the requested panels and assigns every compatible axis to it, so generated comparisons have
matched axes by construction. `shared_axes: false` opts out.

---

## Part 3 — FlowJo layout interop

### Element mapping

| Flowcyto | FlowJo `.wsp` |
|---|---|
| `FlowcytoLayout` | `<Layout name=...>` |
| `layout.canvas` | `<PrintLayout width height imageable*>` |
| `LayoutPanel` | `<ChartData x y width height>` |
| `panel.position` | `ChartData` geometry + `<WindowPosition>` |
| `panel.x` / `panel.y` channel, scale | `<Graph><Axis dimension="x\|y" name=...>` |
| `panel.x.bounds` | **unknown — blocked on E5** |
| `panel.plotType` | `<Graph type="Pseudocolor\|DotPlot\|Contour">` |
| `source.sample` | `DataLayer sampleID` (+ `sampleGMID`, rule unknown) |
| `source.parent` | `DataLayer path` via the resolver |
| `source.legend` | `<LegendSpec>` |
| `panel.show.*` | `ChartData showSampleName` / `showPopulationName` / `showCount` / `showFreq` |
| not modelled | `<Iteration>`, `<BatchSettings>`, `<Ancestry>`, `<Multigraph>`, `<FigColorLegend>` |

### 3a. L4 — Import

Extend `import_flowjo_workspace` with `import_layouts` (default `true`).

Terminology: import **writes workspace state**. It is non-destructive only in the sense that it
never modifies the source `.wsp` or the FCS files it references. Where this plan needs an import
that writes nothing, it says `dry_run` — a mode that performs the full parse, resolution and
validation and returns the panels and diagnostics it would have stored, without touching
`flowcyto.workspace.json`. `scripts/validate-flowjo-layout-paths.mjs` is the current stand-in for
that mode and imports into a fresh temporary workspace each run.

For each `<Layout>`: read `PrintLayout` into `canvas`; build one panel per `<ChartData>` from
`Graph/Axis`, geometry and display flags, and `PopModelList/DataLayer`. Resolve `DataLayer path`
→ gate id with the sample-scoped resolver, and `sampleID` → Flowcyto sample id with the map built
during sample import.

Classify `kind`: one sample with paths forming a descending chain → `gating_strategy`; one path
repeated across samples → `comparison`; otherwise `freeform`.

Every one of these produces an **unresolved panel that is kept**, with a typed status, never a
dropped panel:

- ambiguous path → `ambiguous_path` with candidate ids
- unknown path or sample → `unknown_path` / `unknown_sample`
- name containing `/` → `unsupported_name`
- `Multigraph rows/columns > 0`, `Ancestry backgating="1"`, `Iteration != "OFF"` →
  `unsupported_feature` with the specific construct named

The import result reports counts of resolved and unresolved panels by reason, so a caller can see
exactly what fidelity it got.

### 3b. Precedence for preserved `_flowjo` state

Preserved XML is a presentation cache, not a source of truth, and is **not automatically valid
after edits**.

Live workspace state always overrides preserved values for:

- sample mappings (`sampleID`, `sampleGMID`)
- population references (`DataLayer path`)
- axes (channel, scale, bounds)
- geometry (`ChartData` x/y/width/height and `WindowPosition`)

`_flowjo` may only supply attributes Flowcyto does not model: colours, fills, `GraphSettings`
detail, `GraphEnvironment` detail, legend styling. Anything in the override list is recomputed on
export and the preserved value discarded.

Stale references are never replayed. If a preserved panel references a gate or sample that no
longer resolves, that panel exports as unresolved and is reported — it does not emit the old
`sampleID` or path.

Unresolved panels are **not exported** by default, and are listed explicitly in the export result.
Verbatim replay of an untouched unresolved panel is deliberately deferred until the E-series
experiments show it is safe; it is not in L5 scope.

### 3c. L5 — Export

Extend `export_flowjo_workspace` with `export_layouts` (default `true`), writing one `<Layout>`
per `FlowcytoLayout`.

Identifier and geometry decisions are **deferred to the experiments** rather than assumed:

- `figID` — do not generate timestamp-based ids unless E0/E2 show FlowJo requires a unique,
  parseable value. Prefer a stable deterministic id derived from the panel id, if accepted.
- `sampleGMID` — do not guess a fallback. E3 must establish the assignment rule; until then,
  export refuses layouts whose sources lack a known group mapping and reports why.
- Coordinate units and origin — E1 must establish the relationship between `ChartData` geometry
  and `PrintLayout` page coordinates before any scaling is applied.

Where a decision is unresolved, export fails loudly with a structured error naming the blocking
experiment. It does not emit a plausible guess.

### 3d. Validation (gates L5 merge)

1. Import `20211130 BDC Tet.wsp`; assert two layouts, the six-panel gating strategy chain for
   `B1 44 1-1.fcs`, and the five-sample comparison on `.../Live CD3+/CD4+`. Assert every panel
   resolves to the correct sample, population, axes and compensation state.
2. Export unchanged; diff the `<Layout>` subtree against the original, ignoring only attributes
   the experiments showed to be volatile.
3. **Export an edited layout** — move a panel, change one panel's population, add an overlay
   source — and confirm the result opens correctly in FlowJo 10.8. Round-tripping an unmodified
   file is necessary but not sufficient; edits are where precedence bugs appear.
4. Open both exports in FlowJo 10.8 and confirm the Layout Editor shows the layouts with plots in
   the right positions and correct populations.

Step 3 is the real gate. The prior Datalox FlowJo export work needed several iterations before
FlowJo accepted its output, and layouts are more intricate than gates.

Fixtures: build synthetic `.wsp` files covering a gating strategy layout, a comparison layout, a
two-`DataLayer` overlay panel, an ambiguous sibling-name path, and a name containing `/`. Commit
the E-series baselines. Do not commit the tetramer file or any cohort data.

---

## Part 4 — Gate editor UI (L6)

After the renderer and generators land, add a view switcher to the compact editor: **Plot**
(current single-plot editor), **Strategy** (gating strategy panels, click to jump to a node),
**Compare** (comparison grid). Editing stays in Plot view; layout views are for review and
navigation. Unresolved panels show their status reason in place.

---

## PR sequence

Ordered so the real interoperability requirement is tested before heavy investment in generators.

| PR | Branch | Scope | Depends on |
|---|---|---|---|
| **E** | `docs/flowjo-layout-serialization` | Controlled-change experiments E0–E7, findings doc, baseline fixtures | — |
| **L1** | `feat/layout-schema` | Types, sample-scoped resolver with typed diagnostics, `upsert_layout`/`list_layouts`/`get_layout`, `validate_layout`, bounds-group validation | — |
| **L4** | `feat/flowjo-layout-import` | Import the two real layouts (source files untouched; `dry_run` writes nothing), typed unresolved panels, `_flowjo` preservation | L1, E (partial) |
| **L2** | `feat/layout-render` | `render_layout` / `render_layout_image` against imported layouts, per-source compensation and comparability reporting | L1, L4 |
| **L3** | `feat/layout-generators` | `suggest_gating_strategy_layout`, `suggest_comparison_layout` reusing the L2 renderer | L2 |
| **L5** | `feat/flowjo-layout-export` | Export, precedence enforcement, edited-layout validation in FlowJo | L4, E (complete) |
| **L6** | `feat/gate-editor-layout-views` | Strategy and Compare views in the compact editor | L2, L3 |

E and L1 are independent and can run in parallel; E gates L5 completely and L4 partially.

### First milestone

Import both real layouts and resolve **every supported panel** to the correct sample, population,
axes and compensation state — with unresolved panels explicitly typed rather than missing. Then
render the `.../Live CD3+/CD4+` comparison as three resolved sample plots and two labelled
unresolved placeholders, with bounds verified shared across the three resolved plots. Placeholders
must not contribute fabricated ranges or statistics to bounds-group calculations.

That milestone exercises the resolver, the status model, per-source compensation reporting and the
bounds-group validation before a single generator or line of export XML exists.

---

## How the reference repositories are used

craft-anything and rea are reverse-engineering tools, not layout libraries. Their value here is
methodological, and is already folded into the plan:

- **Controlled-change diffing over inference from one artifact** — the E-series above. This is the
  main borrowing, and it replaces several assumptions the first draft of this plan made.
- **Results that carry confidence, coverage and limitations** — the typed `PanelStatus`,
  per-source compensation reporting and `PanelComparability` report, rather than silent success.
- **Summary-first, then paged, for large results** — `render_layout` on a large layout.

Binary analysis is unnecessary; XML diffs of deliberately minimal edits are stronger evidence and
far cheaper.

## L1 resolver checkpoint (2026-11-18)

Implemented `src/core/gate-path.ts` and focused regression tests. Layout schema, storage,
validation and MCP registrations remain pending; this checkpoint does not claim full L1 completion.

The read-only source probe `scripts/validate-flowjo-layout-paths.mjs` imports into a newly created
temporary directory, never modifies the source WSP/FCS files, and uses explicit sample path/ID
maps. Every resolved DataLayer path must encode back to exactly the original path. It exits
nonzero if any layer remains unresolved; this is intentional, not a hidden partial success.
Round-trip mismatches are reported per layer as `round_trip_mismatch` with the expected path and
actual encoding result; they do not abort the remaining checks. Layout discovery scans the parsed
Workspace rather than requiring a LayoutEditor wrapper. FlowJo-only missing-sample diagnostics
use `flowjoSampleId`, distinct from the resolver's local `sampleId`.

Live result for `20211130 BDC Tet.wsp`: 12 samples and 58 gates imported without importer warnings;
2 layouts, 11 DataLayers checked, 9 resolved and round-tripped exactly.

| Layout | Result |
|---|---|
| `gating` | All 6 panels resolve, including `Single Cells/Single Cells` |
| `Layout-1` | 3 of 5 resolve (sample IDs 1, 19, 18) |
| `Layout-1`, panel indexes 1 and 3 (zero-based) | `unknown_sample`: IDs 2 and 20 are absent from SampleList |

This corrects the earlier assumption that all five comparison sources were available. The source
file already contains dangling sample references. Do not map these to other samples by position,
name similarity or group order. L4 must preserve both panels as unresolved until an explicit,
verified binding is provided. The five-panel milestone means three resolved plots plus two
labelled unresolved panels for this file, not five invented bindings. Axes, compensation and
geometry fidelity have not been validated by this resolver-only probe.

Both missing IDs also occur as group `SampleRef` entries. The probe therefore distinguishes
`group_reference_without_sample_node` from `layout_reference_without_sample_node` while retaining
the common `unknown_sample` status. L4 should carry this evidence in its panel diagnostics; the
generic workspace resolver must not acquire FlowJo XML dependencies. A missing group reference
does not prove corruption, and a retained group reference does not prove deletion history.
Remediation is to recover the original sample definition or explicitly verify a replacement FCS
binding and population hierarchy, not infer a file from the numeric ID.

Reproduce after `npm run build` (substitute local paths):

```powershell
node scripts/validate-flowjo-layout-paths.mjs "C:\Users\fangxf\Research Tools\Flow data\2_20211001_Tet\20211130 BDC Tet.wsp" "C:\Users\fangxf\Research Tools\Flow data\2_20211001_Tet"
```

Before remaining L1 work, specify transform parameters (not only AxisScale names) for bounds-group
compatibility. Different biex/arcsinh parameterizations are not equivalent axes. Likewise, absence
of an explicit compensation ID is not proof of raw data; pre-compensated FCS inputs require
processing provenance before classifying mixed compensation states as scientific errors.
