# Agent-Native Flow Cytometry MCP

## Decision

Build an agent-native flow cytometry workspace, not a clone of FlowJo.

The system should provide an interactive UI for rendering cytometry plots and drawing gates. The agent should own analysis planning, computation, batch processing, validation, and reporting.

The live source of truth should be a small, explicit, file-backed artifact controlled by this MCP. JSON is the recommended internal artifact format.

FlowJo workspace XML can be imported or exported later, but it should not be the canonical live state.

## Why FlowJo Is Not Enough

FlowJo can already do these human-facing tasks:

- Open `.fcs` files.
- Render FSC/SSC and marker plots.
- Draw and edit gates.
- Recalculate dependent statistics when gates move.
- Save analysis state in a FlowJo workspace.
- Run scripts, plugins, and command-line workflows.

The gap is not basic gating. The gap is agent-native state.

FlowJo does not natively expose this loop:

```text
FlowJo UI <-> stable structured artifact <-> agent edits <-> live UI refresh
```

FlowJo stores workspace state as XML. That XML includes gates, vertices, files, gating trees, statistics, layouts, tables, and formulas. However, it is a FlowJo-owned workspace representation. FlowJo's documentation notes that many tags are program-specific, so other programs may not interpret them correctly.

That makes FlowJo XML usable for inspection, export, comparison, or one-way pipeline ingestion. It does not make it a good live artifact contract for an agent.

## XML vs JSON

XML itself is not the problem. A well-defined XML artifact could work.

The problem is FlowJo workspace XML:

- It is broad internal application state, not a minimal gate artifact.
- It includes FlowJo-specific concepts and tags.
- It is not designed as a watched source-of-truth file.
- Safe external writes require understanding FlowJo's internal semantics.
- Live reload from agent edits is not the native workflow.

JSON is recommended because the MCP can define the contract directly:

```json
{
  "version": 1,
  "samples": [
    {
      "id": "sample_001",
      "path": "data/sample_001.fcs"
    }
  ],
  "gates": [
    {
      "id": "lymphocytes",
      "parent": "root",
      "sample": "sample_001",
      "type": "polygon",
      "x": "FSC-A",
      "y": "SSC-A",
      "vertices": [
        [12000, 3000],
        [50000, 4000],
        [60000, 25000],
        [18000, 22000]
      ]
    }
  ]
}
```

This format is easy for agents to inspect, patch, validate, diff, and regenerate. It is also easy for the UI to render and edit.

The key distinction:

```text
Bad canonical artifact: FlowJo-owned XML workspace
Good canonical artifact: MCP-owned structured gating artifact
```

The MCP-owned artifact could be JSON, XML, SQLite, or another structured format. JSON is the simplest default because it fits MCP tools, web UI state, JSON Schema validation, git diffs, and agent-generated code.

## Proposed Boundary

The MCP/UI should provide:

- FCS metadata access.
- Deterministic event preview or downsample access.
- Plot rendering.
- Polygon, range, rectangle, and quadrant gate editing.
- Gate tree editing.
- Artifact read/write.
- Live refresh when the artifact changes.
- Import/export hooks for standard formats.

The agent should provide:

- Analysis planning.
- Compensation and transformation decisions.
- Statistics computation.
- Batch application of gates.
- Quality control checks.
- Report generation.
- Code execution using Python, R, or other cytometry libraries.

The UI may do small deterministic computation required for interaction, such as rendering transforms, point binning, downsampling, and hit-testing. It should not hard-code biological analysis heuristics.

## Artifact Strategy

Use three layers:

```text
Raw data: FCS
Live workspace artifact: JSON
Interchange formats: Gating-ML, FlowJo WSP XML, CSV, FCS exports
```

The JSON artifact should be the canonical editable workspace.

Gating-ML should be preferred for standards-based gate interchange.

FlowJo workspace XML should be treated as an import/export compatibility format, not the system's internal state model.

## MVP

The first useful version should do only this:

1. Open an `.fcs` file.
2. Read parameters and event previews.
3. Render FSC/SSC and marker plots.
4. Let the user draw and edit gates.
5. Save gates into a JSON artifact.
6. Let the agent read and update that artifact.
7. Refresh the UI when the artifact changes.

This is enough to prove the core agentic experience:

```text
human adjusts gate -> artifact changes -> agent sees it
agent updates gate -> artifact changes -> human sees it
```

## Non-Goals

Do not start by replacing all of FlowJo.

Do not start by implementing full cytometry computation inside the MCP.

Do not use FlowJo workspace XML as the canonical state.

Do not hide the analysis state inside a database or GUI-only session.

Do not add auto-gating heuristics unless the agent explicitly creates and validates them as code.

## Product Positioning

The strongest positioning is:

```text
An agent-native gating artifact and interactive cytometry UI that can interoperate with FlowJo, then gradually make FlowJo optional.
```

The value is not that FlowJo cannot gate. The value is that FlowJo is not built around live, file-backed, agent-readable, bidirectional state.

## References

- FlowJo Workspace XML: https://www.flowjo.com/docs/flowjo10/workspaces-and-samples/ws-ribbons-and-tabs/ws-ribbon-band-debug/workspace-xml
- FlowJo Plugins: https://www.flowjo.com/docs/flowjo10/plugins
- FlowJo Script Editor: https://docs.flowjo.com/flowjo/advanced-features/script-editor/
- Command Line FlowJo: https://docs.flowjo.com/flowjo/advanced-features/fj-commandline/
- MCP Apps: https://modelcontextprotocol.io/extensions/apps/overview
