# Flowcyto MCP

Alpha flow cytometry MCP server, CLI, and compact gate editor.

The goal is a file-backed, agent-native gate editor:

```text
FCS file -> flowcyto.workspace.json -> MCP tools -> compact plot UI -> revision-safe JSON updates
```

This is not a FlowJo replacement yet. It is an internal alpha for validating the
agentic workflow: open FCS metadata/previews, draw/edit gates, write structured
JSON, and reflect agent-side changes live in the open surface.

## Install

Use Node.js 20 or newer.

For host-specific setup in Codex, Claude Desktop, VS Code, and Cursor, see
[docs/mcp-host-setup.md](docs/mcp-host-setup.md).

Register the published alpha package directly in an MCP host:

```json
{
  "mcpServers": {
    "flowcyto": {
      "command": "npx",
      "args": ["-y", "-p", "@datalox/flowcyto-mcp@alpha", "flowcyto-mcp"]
    }
  }
}
```

On Windows, wrap `npx` with `cmd /c`:

```json
{
  "mcpServers": {
    "flowcyto": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "-p", "@datalox/flowcyto-mcp@alpha", "flowcyto-mcp"]
    }
  }
}
```

Use the CLI from the package without a global install:

```bash
npx -y -p @datalox/flowcyto-mcp@alpha flowcyto doctor
```

Maintainers can smoke-test the local tarball before each publish:

```bash
npm run verify:publish
```

## Contributor Setup

From a checkout:

```bash
npm ci
npm run build
npm run fixtures:fetch
npm run verify:alpha
```

Create and inspect an installable alpha tarball:

```bash
npm run smoke:package -- --keep-tarball
```

The npm package exposes two bins: `flowcyto` for CLI workflows and
`flowcyto-mcp` for MCP stdio hosts. MCP host configs should call
`flowcyto-mcp` explicitly.

## Workspace

Any user directory can be a run directory. The folder name is not part of the
contract.

```text
my-cytometry-run/
  flowcyto.workspace.json
  data/
    sample_001.fcs
  reports/
  .datalox/
    cache/
      previews/
    ui-state.json
```

Create a workspace:

```bash
flowcyto init /path/to/my-cytometry-run \
  --sample /path/to/sample_001.fcs \
  --sample-id sample_001
```

Validate it:

```bash
flowcyto validate /path/to/my-cytometry-run/flowcyto.workspace.json
```

The canonical artifact is `flowcyto.workspace.json`. Gates are stored as
structured JSON with a `revision` field so the UI and agent can reject stale
writes instead of overwriting each other.

## CLI

Open or create a workspace from a raw FCS file:

```bash
flowcyto open-fcs /path/to/sample_001.fcs --workspace-dir /path/to/my-cytometry-run
```

Read metadata:

```bash
flowcyto metadata /path/to/my-cytometry-run/flowcyto.workspace.json \
  --sample sample_001
```

Render a capped point preview:

```bash
flowcyto preview /path/to/my-cytometry-run/flowcyto.workspace.json \
  --sample sample_001 \
  --x FSC-A \
  --y SSC-A \
  --max-events 10000
```

Render a binned preview for larger display requests:

```bash
flowcyto preview /path/to/my-cytometry-run/flowcyto.workspace.json \
  --sample sample_001 \
  --x FSC-A \
  --y SSC-A \
  --format bins \
  --max-events 60000
```

Open the compact native preview window on macOS, or on Windows when the
WebView2 helper has been built:

```bash
flowcyto open-gate-editor-window /path/to/my-cytometry-run/flowcyto.workspace.json
```

Windows compact native preview parity uses a thin WebView2 helper and the same
`surface.kind="native_window"` contract as macOS. Windows release validation
still needs to be run on a Windows machine with WebView2 installed. See
[docs/windows-webview2-compact-window.md](docs/windows-webview2-compact-window.md).

Open the browser debug surface:

```bash
flowcyto open-gate-editor /path/to/my-cytometry-run/flowcyto.workspace.json
```

The browser route is for debugging and Playwright coverage. The intended user
surface is the MCP embedded app or the compact native preview.

## Agent Discovery

No `AGENTS.md` file is required for the product path. Agents should discover the
workflow from MCP tool descriptors, resources, prompts, and `nextAction`
results.

Example user prompts:

```text
Open this FCS file and gate the main population.
Render FSC-A versus SSC-A for this sample.
Review the gates in this flowcyto.workspace.json.
```

Primary tool path:

```text
open_fcs -> open_gate_editor -> render_plot or get_plot_context -> upsert_gate -> get_workspace_revision
```

For gating or population inspection, agents should not stop after `open_fcs`.
The `open_fcs` result includes a required `nextAction` that opens the compact
gate editor. In fresh CLI agents this defaults to
`open_gate_editor(surface="native_window")`; MCP Apps hosts can request
`surface="mcp_app"` for the embedded resource.

The MCP server also exposes:

```text
flowcyto://capabilities
flowcyto://workflow/open-fcs-and-gate
open-fcs-and-gate-main-population prompt
render-fcs-plot prompt
review-workspace-gates prompt
```

## Live Gating Demo

Create the disposable demo repo used for recording:

```bash
node scripts/create-live-gating-demo.mjs --target ../flowcyto-live-gating --force
```

That repo starts with `revision: 0`, no gates, one FCS file, `.mcp.json`,
`README.md`, and a thin optional `AGENTS.md` hint. It intentionally has no gate
writer scripts; the product path is carried by MCP descriptors/results:
`open_gate_editor` -> `get_plot_context` -> `upsert_gate` ->
`get_workspace_revision`.

Validate the final demo artifact after a host run:

```bash
node scripts/validate-live-demo-result.mjs \
  --workspace ../flowcyto-live-gating/flowcyto.workspace.json
```

## MCP Registration

Stdio MCP entrypoint:

```bash
flowcyto-mcp
```

Streamable HTTP MCP entrypoint:

```bash
flowcyto-mcp --http --host 127.0.0.1 --port 8787
```

Register this endpoint in a Streamable HTTP MCP-capable host:

```text
http://127.0.0.1:8787/mcp
```

The host should discover these tools:

```text
open_fcs
render_plot
render_plot_image
open_gate_editor
get_plot_context
get_workspace_revision
read_workspace
write_workspace
validate_workspace
get_sample_metadata
get_event_preview
upsert_gate
delete_gate
list_compensations
get_compensation_matrix
render_gate_editor (deprecated alias)
get_gate_editor_state (deprecated alias)
```

AGENTS.md is not part of the product contract. Hosts may read it, ignore it, or
merge it with user-specific instructions. The portable agent contract is:

```text
open_fcs returns required nextAction.tool = open_gate_editor for gating/inspection
open_gate_editor returns nextAction.tool = get_plot_context
get_plot_context returns recommendedGate and nextAction.tool = upsert_gate
upsert_gate returns nextAction.tool = get_workspace_revision
```

Agents should write gates through `upsert_gate` with the `expected_revision`
returned by `get_plot_context`; they should not patch `flowcyto.workspace.json`
directly or inspect local preview URLs as a data source.

Use `render_plot` for agent-readable preview data and gate geometry. Use
`render_plot_image` when the user asks for an inline graph; it renders a
deterministic image from the same preview bins/points and active gate context.
By default it also writes the SVG under `.datalox/cache/plots/` so hosts that do
not display MCP image content inline can still return a concrete file path.

The embedded app resource is:

```text
ui://flowcyto/gate-editor-v1.html
```

Expected live loop:

```text
agent calls open_gate_editor -> compact app opens from the UI resource
agent calls upsert_gate -> workspace revision increments
open UI polls revision -> new gate appears without manual reload
human draws/edits gate -> workspace revision increments
```

Keep HTTP bound to localhost for alpha. Do not expose the HTTP server on a public
network without TLS, authentication, and a deployment review.

## Fixture Coverage

Fetch external FCS fixtures:

```bash
npm run fixtures:fetch
```

Fixtures are declared in:

```text
testdata/fixtures/manifest.json
```

The current external fixtures come from Bioconductor `flowCore` extdata under
the Artistic-2.0 license. The package includes the manifest and fetch script,
not the downloaded FCS binaries.

## Alpha Limitations

- Internal alpha only.
- Not a validated clinical, diagnostic, or regulated analysis product.
- Not a full FlowJo replacement.
- FCS parser coverage is fixture-driven but still incomplete.
- No Gating-ML import/export yet.
- No FlowJo workspace import/export yet.
- No public-network HTTP security posture yet.
- Real named MCP-host validation is still required before public beta.
- The UI is optimized for manual gating and visual review, not full batch
  cytometry analysis.

## License

This project is licensed under AGPL-3.0-or-later. See [LICENSE](LICENSE).

Commercial licensing can be offered separately for organizations that need to
embed, redistribute, or deploy the product without AGPL obligations.
