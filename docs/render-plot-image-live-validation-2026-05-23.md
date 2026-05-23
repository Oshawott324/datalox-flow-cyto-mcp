# Render Plot Image Live Validation 2026-05-23

## Scope

Validate two Flowcyto MCP product fixes:

1. Windows native WebView2 packaging/readiness.
2. `render_plot_image` deterministic inline plot image export from the same
   preview bins/points used by `render_plot` and `get_plot_context`.

## Environment

- OS: Windows
- Node: 22.19.0
- Repo: `C:\Users\fangxf\Research Tools\datalox-flow-cyto-mcp\datalox-flow-cyto-mcp`
- MCP local entrypoint: `dist/src/mcp/server.js`

## Data Matrix

Primary fast live-fix set:

| Case | Source | Reason |
| --- | --- | --- |
| Accuri C6 | `C:\Users\fangxf\Research Tools\Flow data\3_parsing_test\2_Accuri_C6.fcs` | Small parser smoke case with simple FSC/SSC names. |
| BMDC Tube 026 | `C:\Users\fangxf\Research Tools\Flow data\1_20230315_BMDC\Unmixed\samples\Tube_026.fcs` | Real unmixed sample with practical biological channel set. |
| Tet Negative Control | `C:\Users\fangxf\Research Tools\Flow data\2_20211001_Tet\A5 Negative Control.fcs` | Axis labels with spaces, slashes, and longer names. |
| Aurora Unmixed Filtered | `C:\Users\fangxf\Research Tools\Flow data\3_parsing_test\4_Aurora_Unmixed_filtered.fcs` | Rich marker panel and larger filtered dataset. |

Stress case:

| Case | Source | Reason |
| --- | --- | --- |
| Zingvu concat | `C:\Users\fangxf\Research Tools\Flow data\5_Zingvu\concat_1_CMP JHU D5.fcs` | 76 MB binned rendering stress case. |

Disposable workspaces were created under `.datalox/live-validation/`.

## Results

### Windows Native WebView2

Observed original packaged layout:

- `dist/native/windows/win-x64/flowcyto-webview2-window.exe` existed.
- `dist/native/windows/win-x64/WebView2Loader.dll` was missing.

Fix:

- Added `windowsWebView2LoaderPath`.
- `nativeGateEditorReadiness` now requires both exe and loader DLL.
- `nativeGateEditorLaunchPlan` fails early with
  `windows_webview2_loader_missing` if the loader is not beside the exe.
- Added `scripts/verify-windows-native-package.mjs`.
- Windows native build scripts now run the verifier after publish.

Local verification:

```text
node scripts/verify-windows-native-package.mjs win-x64
node dist/src/cli/main.js doctor
```

Both passed. `doctor` reports `native_preview` as `windows_webview2`.

MCP live open/close:

```text
open_gate_editor(surface="native_window")
```

Passed. The returned surface was `native_window`, runtime
`windows_webview2`, with a live local `mcp-app-preview` URL. The session closed
with `close_gate_editor`.

### Deterministic Plot Image

Implementation:

- Added `src/core/scale.ts` for transform, inverse transform, tick, and tick
  formatting helpers.
- Added `src/core/colormap.ts` for shared density colors.
- Added typed `getRenderablePlotContext`.
- Added `src/app/gate-editor/plot-image.ts`.
- Added MCP tool `render_plot_image`.
- Added MCP tool `probe_inline_image` for host SVG/PNG rendering diagnosis.

Current image format:

```text
image/svg+xml
```

Codex Desktop fresh-host probe result:

```text
probe_inline_image returned SVG and PNG metadata, but neither image was visibly
rendered inline in chat.
```

Decision:

```text
Do not add PNG rasterization yet. Codex did not visibly render MCP image
content for either SVG or PNG, so the useful compatibility path is a file-backed
plot export.
```

The SVG is generated from `getRenderablePlotContext`, which uses the same
`getEventPreview` path as `render_plot` and `get_plot_context`.

`render_plot_image` now supports:

```text
output: "content" | "file" | "both"
```

The default is `both`: MCP image content plus an SVG file path. The default file
location is:

```text
<workspace>/.datalox/cache/plots/<stable-name>.svg
```

Primary data matrix render results:

| Case | Status | Sampled events | SVG bytes |
| --- | ---: | ---: | ---: |
| Accuri C6 | pass | 2,000 | 106,223 |
| BMDC Tube 026 | pass | 7,888 | 132,870 |
| Tet Negative Control | pass | 39,887 | 97,294 |
| Aurora Unmixed Filtered | pass | 47,941 | 231,097 |
| Zingvu concat stress | pass | 57,039 | 242,182 |

### Automated Tests

Commands:

```text
npm run build
npm test
node dist/src/cli/main.js doctor
node scripts/verify-windows-native-package.mjs win-x64
```

Final status:

```text
npm test: 36 passed
doctor: ok true
windows native package verifier: ok true
```

## Fresh Host Checks Still Needed

Codex Desktop must be restarted so it discovers the newly built MCP tools.

Codex Desktop has already shown that MCP image content is not visible inline.
After restarting Codex Desktop, ask:

```text
Open this FCS file and show FSC-A vs SSC-A. If the graph is not visible inline,
return the render_plot_image file path:
C:\Users\fangxf\Research Tools\Flow data\3_parsing_test\2_Accuri_C6.fcs
```

Expected MCP flow:

```text
open_fcs -> render_plot_image
```

Expected user-visible result:

```text
Rendered plot saved to <workspace>/.datalox/cache/plots/<stable-name>.svg
```

For gating:

```text
Open this FCS file, show the plot inline, then gate the main population:
C:\Users\fangxf\Research Tools\Flow data\3_parsing_test\2_Accuri_C6.fcs
```

Expected MCP flow:

```text
open_fcs -> render_plot_image -> open_gate_editor -> get_plot_context -> upsert_gate -> get_workspace_revision
```

## Notes

`render_plot` remains the agent-readable structured data tool. `render_plot_image`
is the human-visible image tool. `open_gate_editor` remains the interactive
compact editor entrypoint.
