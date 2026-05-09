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

From a checkout:

```bash
npm ci
npm run build
npm run fixtures:fetch
npm run verify:alpha
```

Create an installable alpha tarball:

```bash
npm pack
npm install -g ./datalox-flowcyto-mcp-0.1.0.tgz
flowcyto doctor
```

The package name is set to `@datalox/flowcyto-mcp`, but publishing is disabled
with `private: true` until the real MCP-host validation gate passes.

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

## Live Gating Demo

Create the disposable demo repo used for recording:

```bash
node scripts/create-live-gating-demo.mjs --target ../flowcyto-live-gating --force
```

That repo starts with `revision: 0`, no gates, one FCS file, `.mcp.json`,
`README.md`, and `AGENTS.md`. It intentionally has no gate writer scripts; the
agent path is `open_gate_editor` -> `get_plot_context` -> `upsert_gate`.

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
render_gate_editor (deprecated alias)
get_gate_editor_state (deprecated alias)
```

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
