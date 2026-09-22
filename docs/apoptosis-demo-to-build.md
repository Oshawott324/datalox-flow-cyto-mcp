# Apoptosis Demo: To-Build Backlog

## Purpose

Track capabilities needed to move from the current reliable compensation-and-quadrant demo to a deterministic, full scientific apoptosis workflow. This document separates product work from prompt wording so the demo does not claim behavior the tools cannot yet guarantee.

## Record-Now Boundary

The current record-ready path can:

- create a fresh timestamped workspace with stable sample IDs;
- derive and save compensation from explicit single-stain controls;
- compare derived and embedded spillover values;
- render samples without opening editor windows;
- suggest, write, edit, propagate, and evaluate one coupled quadrant gate;
- align propagated quadrant populations by `name_path`; and
- export/import supported gate geometry through reference-only FlowJo workspaces.

The focused video applies the quadrant at the root population and must disclose that a full biological analysis should first establish morphology and singlet parents.

## P0: Full Hierarchy Demo

### Dedicated main-cell suggestion

Add `suggest_main_cell_gate` with an apoptosis-safe `mode="non_debris"` contract.

Required output:

- conservative FSC-A/SSC-A polygon geometry;
- exact count and percent of the selected parent retained;
- diagnostic bounds and excluded-event summary;
- explicit warning that lower-FSC apoptotic events must be retained;
- read-only `nextAction` for revision-safe `upsert_gate`; and
- deterministic behavior suitable for live recording.

This removes the current dependency on an agent inventing polygon coordinates from rendered plot context.

### Draft hierarchy evaluation

Allow read-only suggestions and population calculations against an in-memory proposed hierarchy before any workspace write.

Required behavior:

- evaluate singlets inside a proposed main-cell polygon;
- evaluate apoptosis quadrants inside proposed singlets;
- return exact draft counts and percentages;
- preserve the same IDs and geometry when the approved hierarchy is written; and
- permit one approval for the complete hierarchy instead of sequential write-to-evaluate approvals.

### Parent-aware incremental propagation

Allow a reviewed child gate to propagate into an already propagated matching parent hierarchy without requiring all source ancestors to be selected again.

The operation must resolve parents by traceable source identity, reject ambiguous matches, and remain revision-safe. Until this exists, callers must pass main-cell, singlet, and quadrant source gate IDs together.

## P0: Demo Reliability

### Matched multi-sample rendering

Add a deterministic small-multiple or matched-bounds render operation for FSC/SSC and Annexin/PI comparisons across samples. The result should expose shared numeric bounds, sample labels, event counts, and compensation state.

### Full-workflow validation harness

Extend `scripts/create-apoptosis-demo.mjs --run-analysis` to validate the complete main-cell -> singlet -> quadrant hierarchy once the main-cell suggestion and draft-evaluation contracts exist.

The harness should fail when:

- a required sample or channel is absent;
- compensation is not the reviewed derived matrix;
- any child has the wrong parent;
- propagated name paths do not align;
- the unstained control is not predominantly viable; or
- the positive control does not show the expected apoptosis enrichment.

### Replayable demo manifest

Write a machine-readable manifest per timestamped run containing input file paths and hashes, tool/package version, compensation comparison, workspace revisions, approved gate IDs, generated artifact paths, and final QC assertions.

## P1: FlowJo Interoperability

### Saved display-transform validation

The gate editor now persists selected per-sample axis scales and the exporter emits corresponding FlowJo sample transformations while retaining gate coordinates in raw FCS space. Validate linear and biex selections in FlowJo on the real apoptosis workspace and tune the exported biex parameters only from a FlowJo-authored reference, not by visual guesswork.

### Native quadrant workspace encoding

Implemented from a FlowJo 10.10 Windows-authored apoptosis workspace: Flowcyto retains one coupled quadrant internally, exports it as FlowJo's four sibling one-sided `RectangleGate` populations, and reconstructs matching rectangle quartets as one coupled quadrant during import. Complete the acceptance check by opening `flowcyto-apoptosis-export-native-quadrants.wsp` in FlowJo and confirming all four named populations appear under the intended parent for every sample.

### Compensation round-trip

Implement FlowJo compensation matrix import and export. Preserve channel mapping, matrix orientation, matrix name/ID, and sample/global scope. Add a real FlowJo-open validation, not only XML re-import tests.

### Quadrant display-name fidelity

Preserve semantic population names such as `Viable` and `Early apoptotic` across FlowJo export/import instead of reconstructing names from IDs.

### Workspace fidelity statement

Define and test the supported interchange boundary for layouts, statistics, groups, transforms, keywords, and bundled FCS files. Keep `reference_only` explicit until bundling is implemented.

### FlowJo-native compatibility hardening

Use the prior `Complexity-LLC/datalox@flowcyto-mcp-tool-loading` exporter as a structural reference without porting its old domain model. Reuse these proven boundaries:

- map internal gate IDs to deterministic FlowJo-style `ID##########` XML IDs while retaining traceability back to canonical Flowcyto IDs;
- emit the minimal FlowJo 10 workspace scaffold, including `Groups`, `SampleRefs`, `Matrices`, `Cytometers`, `TableEditor`, `LayoutEditor`, and other required empty editor sections;
- validate duplicate IDs, missing parents, channel references, sample URIs, and unsupported constructs before writing;
- adopt a versioned compatibility profile for the FlowJo versions and platforms actually tested; and
- add captured real FlowJo 10 Windows fixtures to export validation instead of relying only on Flowcyto export/import self-round trips.

The prior branch fixture corpus includes FlowJo 10.8.1 and 10.10.0 Windows workspaces with nested polygon/rectangle hierarchies. Use those fixtures to derive structural assertions, then perform the decisive acceptance test by opening a newly generated workspace in FlowJo and confirming that samples, populations, gates, transforms, and parent relationships are visible.

### FlowJo layout export

Add an explicit layout model rather than treating saved plot views as FlowJo layouts. Export named `LayoutEditor` layouts that can contain multiple sample/population graphs, including a cross-sample Annexin/PI grid with fixed axes and a gate-strategy layout showing main-cell, singlet, and quadrant stages. Validate generated layouts by opening them in FlowJo; XML self-round-trip tests are not sufficient.

## P1: Contract and Documentation Cleanup

- Replace stale examples that use `negative_control_sample_id` with `negative_control: { sample_id, parent_gate_id? }`.
- Keep `parent_gate_id`, `negative_percentile`, and `compensation_id` explicit in apoptosis examples.
- Document that `propagate_gates` currently requires selected ancestors.
- Reconcile planning documents that describe `suggest_main_cell_gate` as implemented with the actual MCP tool registry.
- Add a checked example for opening every raw FCS file with stable `sample_id`, one shared `workspace_dir`, and `surface="none"`.

## P2: Advanced Quadrant Geometry

Keep the current axis-aligned quadrant primitive simple and coupled. Treat FlowJo-style spider, offset-arm, or curved quadrant gates as separate future geometry types with explicit endpoints or curve parameters. Do not overload two scalar thresholds with those semantics.

## Completion Criteria

The full scientific demo becomes record-ready when:

1. all three hierarchy levels have deterministic read-only proposals;
2. exact percentages can be reviewed before writes;
3. one approved hierarchy can be written and propagated safely;
4. unstained and positive-control QC assertions pass on the real dataset;
5. the complete run succeeds from a fresh timestamped workspace without manual JSON edits; and
6. the recorded claims match the tested FlowJo interoperability boundary.
