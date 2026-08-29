# Flowcyto MCP Host Setup

Use this guide to connect Flowcyto MCP to Codex, Claude Desktop, VS Code, and
Cursor.

Flowcyto MCP exposes the same tools in every host. The host controls how those
tools are registered and whether the compact gate editor appears as an embedded
MCP app, a native window, or an exported SVG image.

## Requirements

- Node.js 20 or newer.
- A trusted Flowcyto MCP package or local checkout.
- Access to the `.fcs` files you want to open.

For local development from this repository, build first:

```powershell
npm ci
npm run build
```

## Published Package Config

Use this config for most users.

macOS/Linux:

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

Windows:

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

## Local Development Config

Use this config when testing the current checkout instead of the published
package. Replace the path with your local repository path.

```json
{
  "mcpServers": {
    "flowcyto": {
      "command": "node",
      "args": [
        "C:/Users/fangxf/Research Tools/datalox-flow-cyto-mcp/datalox-flow-cyto-mcp/dist/src/mcp/server.js"
      ]
    }
  }
}
```

Use forward slashes in JSON paths on Windows, or escape backslashes.

## Codex Desktop

Codex can use MCP servers from its MCP settings or Codex config.

Recommended UI path:

1. Open Codex Desktop settings.
2. Open MCP Servers.
3. Add a server named `flowcyto`.
4. Use the published package config above, or the local development config when
   testing this repository.
5. Restart Codex Desktop after changing MCP configuration.
6. Start a fresh chat and ask Codex to use Flowcyto MCP.

Manual config path:

```toml
[mcp_servers.flowcyto]
command = "cmd"
args = ["/c", "npx", "-y", "-p", "@datalox/flowcyto-mcp@alpha", "flowcyto-mcp"]
enabled = true
```

For a local checkout:

```toml
[mcp_servers.flowcyto]
command = "node"
args = ["C:/Users/fangxf/Research Tools/datalox-flow-cyto-mcp/datalox-flow-cyto-mcp/dist/src/mcp/server.js"]
enabled = true
```

After setup, a fresh Codex session should expose tools such as `open_fcs`,
`open_gate_editor`, `render_plot_image`, `list_compensations`, and
`get_compensation_matrix`.

## Claude Desktop

Claude Desktop reads MCP server configuration from its desktop config file.
Only MCP servers registered with Claude Desktop are available to Claude chats.
Servers registered only in Codex, Cursor, or VS Code do not automatically appear
in Claude.

Add Flowcyto under Claude Desktop's `mcpServers` config using the published
package or local development config above, then restart Claude Desktop.

Windows example:

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

If Claude reports that Flowcyto tools are missing, the MCP server is not
registered in Claude Desktop or failed to start. Reopen Claude's MCP settings,
restart Claude Desktop, and verify that `flowcyto` is connected.

## VS Code

VS Code supports MCP server configuration in workspace or user config. Use VS
Code's Command Palette to add or manage servers:

```text
MCP: Add Server
MCP: List Servers
MCP: Open Workspace Folder MCP Configuration
MCP: Open User Configuration
MCP: Reset Cached Tools
```

Workspace config path:

```text
.vscode/mcp.json
```

Example `.vscode/mcp.json` for local development:

```json
{
  "servers": {
    "flowcyto": {
      "type": "stdio",
      "command": "node",
      "args": [
        "C:/Users/fangxf/Research Tools/datalox-flow-cyto-mcp/datalox-flow-cyto-mcp/dist/src/mcp/server.js"
      ]
    }
  }
}
```

Open VS Code Chat in Agent mode after starting the server. A VS Code pass does
not require embedded MCP app support. Flowcyto is usable if the agent can call
the tools and can use `surface="native_window"` or `surface="none"` plus
`render_plot_image`.

## Cursor

Cursor uses different config locations from VS Code:

```text
.cursor/mcp.json
~/.cursor/mcp.json
```

Example `.cursor/mcp.json`:

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

Cursor supporting Flowcyto does not prove VS Code is configured. It proves the
Flowcyto MCP server can run under a local MCP stdio host. VS Code still needs
its own MCP registration and validation.

## First Validation Prompt

Use this after registering Flowcyto MCP in any host:

```text
Use Flowcyto MCP to open this FCS file and show the FSC-A vs SSC-A gate editor:

<path-to-your-file.fcs>

Use a fresh workspace directory:
<path-to-fresh-workspace-dir>

Follow the Flowcyto MCP contract exactly:
1. open_fcs
2. follow open_fcs.nextAction immediately
3. get_plot_context or render_plot for FSC-A vs SSC-A
4. upsert_gate only if I ask you to write a gate
5. get_workspace_revision after writing a gate

Also check whether compensationSummary.available is true. If compensation is
available, call list_compensations and get_compensation_matrix, but do not apply
compensation unless I confirm.
```

## Expected Agent Workflow

The agent should follow this tool path:

```text
open_fcs
-> follow result.nextAction
-> open_gate_editor or render_plot_image
-> get_plot_context or render_plot
-> upsert_gate
-> get_workspace_revision
```

For UI surface choice:

- Use `surface="mcp_app"` when the host supports embedded MCP apps and
  widget-accessible tools.
- Use `surface="native_window"` when embedded app support is unavailable but a
  native compact window is available.
- Use `surface="none"` plus `render_plot_image` for render-only automation or
  hosts without UI support.

## Troubleshooting

If the host cannot find Flowcyto tools:

- Confirm the MCP config is in that host's config location.
- Restart the host after editing MCP configuration.
- If using local development config, run `npm run build`.
- If using the published package config, run `npx -y -p @datalox/flowcyto-mcp@alpha flowcyto doctor` in a terminal.
- In VS Code, run `MCP: Reset Cached Tools`.

If the embedded gate editor shows `Invalid MCP tool call params`:

- Check whether the host honors `openai/widgetAccessible`.
- Confirm the host sees current tools, especially `get_plot_context`,
  `get_workspace_revision`, `upsert_gate`, and `delete_gate`.
- Restart the host so it reloads the latest MCP tool schemas.
- Use `surface="native_window"` or `render_plot_image` to continue the workflow.

If the plot opens on timing channels such as `TLSW` vs `TMSW`:

- Ask the agent to use the recommended FSC/SSC area channels returned by
  `open_fcs`.
- Expected example axes are `FSC 488/10-A` vs `SSC 488/10-A`.

If compensation exists:

- The agent should inspect it with `list_compensations` and
  `get_compensation_matrix`.
- The agent should only apply it by explicitly passing `compensation_id`.
- If the file may already be compensated or spectral/unmixed, confirm with the
  user before applying conventional compensation.

## References

- VS Code MCP server setup:
  <https://code.visualstudio.com/docs/agent-customization/mcp-servers>
- VS Code MCP extension guide:
  <https://code.visualstudio.com/api/extension-guides/ai/mcp>
- Cursor MCP setup:
  <https://prod.cursor.com/docs/mcp>
