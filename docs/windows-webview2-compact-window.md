# Windows WebView2 Compact Window Parity

## Decision

Implement Windows parity with a thin native WebView2 helper, not Electron.

Reason:

```text
same UI bundle
same /mcp-app-preview bridge
same revision polling
small native window
no bundled Chromium shell
```

The macOS path already does this with `WKWebView`. Windows should do the same
with Microsoft Edge WebView2.

Official WebView2 context:

- Microsoft describes WebView2 as a way to embed web technologies in native apps.
- Microsoft recommends checking for the WebView2 Runtime before creating a
  WebView2 and installing or directing users to install it if missing.
- Evergreen Runtime is the preferred alpha path because it receives automatic
  Microsoft Edge/WebView2 security updates and is shared by WebView2 apps.

References:

```text
https://learn.microsoft.com/en-us/microsoft-edge/webview2/
https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution
https://learn.microsoft.com/en-us/microsoft-edge/webview2/get-started/win32
```

## Target UX

The command should be identical across platforms:

```bash
flowcyto open-gate-editor-window /path/to/run/flowcyto.workspace.json
```

Expected output on Windows:

```json
{
  "ok": true,
  "surface": {
    "kind": "native_webview",
    "runtime": "windows_webview2",
    "preferredWidth": 620,
    "preferredHeight": 620
  }
}
```

The user should see a small desktop window containing the same compact plot
surface, not a browser tab.

## Boundary

The Windows helper must stay thin.

It owns:

```text
native window frame
WebView2 control
loading the local /mcp-app-preview URL
ready/error stdout protocol
process lifetime
```

It must not own:

```text
FCS parsing
workspace validation
gate editing rules
MCP tool behavior
preview generation
scientific state
```

All scientific and file-backed behavior remains in the existing TypeScript
server/core. The Windows helper is only a view host.

## Architecture

Current macOS path:

```text
flowcyto open-gate-editor-window
  -> startGateEditorServer(...)
  -> launchNativeGateEditorWindow(...)
  -> osascript JXA
  -> WKWebView loads /mcp-app-preview
```

Target Windows path:

```text
flowcyto open-gate-editor-window
  -> startGateEditorServer(...)
  -> launchNativeGateEditorWindow(...)
  -> flowcyto-webview2-window.exe
  -> WebView2 loads /mcp-app-preview
```

Keep one TypeScript entrypoint:

```ts
launchNativeGateEditorWindow(options)
```

Platform dispatch:

```text
darwin -> macOS WKWebView helper
win32  -> Windows WebView2 helper
other  -> native_window_unsupported
```

Runtime labels:

```ts
type NativeGateEditorRuntime =
  | "macos_wkwebview"
  | "windows_webview2"
```

## Helper Implementation

Use a small C# WinForms helper first.

Recommended layout:

```text
native/
  windows/
    FlowcytoGateEditorWindow/
      FlowcytoGateEditorWindow.csproj
      Program.cs
      MainForm.cs
```

Why C# WinForms first:

```text
less Win32 boilerplate than C++
WebView2 package is standard through NuGet
easy to build in GitHub Actions on windows-latest
small enough to audit
no Electron-style runtime ownership
```

Project dependency:

```xml
<PackageReference Include="Microsoft.Web.WebView2" Version="*" />
```

The implementation should pin a specific WebView2 SDK version before release
instead of leaving `*` in committed code.

Helper command shape:

```text
flowcyto-webview2-window.exe <url> <title> <width> <height>
```

Example:

```text
flowcyto-webview2-window.exe ^
  http://127.0.0.1:50514/mcp-app-preview ^
  "flowcyto.workspace.json - Flowcyto" ^
  620 ^
  640
```

Stdout protocol:

```text
flowcyto_native_window_ready
flowcyto_native_window_error <machine-readable message>
```

Use the same ready token as macOS unless there is a concrete reason to split it.

## C# Behavior

Minimal behavior:

```csharp
[STAThread]
static async Task Main(string[] args) {
  var url = args[0];
  var title = args.Length > 1 ? args[1] : "Flowcyto Gate Editor";
  var width = args.Length > 2 ? int.Parse(args[2]) : 620;
  var height = args.Length > 3 ? int.Parse(args[3]) : 620;

  ApplicationConfiguration.Initialize();
  using var form = new MainForm(url, title, width, height);
  Application.Run(form);
}
```

`MainForm`:

```text
sets title and size
creates WebView2
docks WebView2 to fill
uses a dedicated user data folder
awaits EnsureCoreWebView2Async()
navigates to URL
writes ready token after navigation starts or WebView2 initialization succeeds
exits process when the window closes
```

Use a stable user data folder:

```text
%LOCALAPPDATA%\Datalox\FlowcytoMcp\WebView2
```

Do not use the repository directory for WebView2 user data.

## Runtime Detection

Before launching the helper, the TypeScript wrapper should check:

```text
process.platform === "win32"
helper executable exists
target URL is localhost or 127.0.0.1
```

The helper should check WebView2 Runtime availability before showing a blank
window.

Recommended helper-side check:

```text
CoreWebView2Environment.GetAvailableBrowserVersionString()
```

If no runtime is present, exit with:

```json
{
  "ok": false,
  "errors": [
    {
      "path": "/surface/runtime",
      "code": "webview2_runtime_missing",
      "message": "Microsoft Edge WebView2 Runtime is required for the Windows native gate editor window."
    }
  ]
}
```

The CLI should not silently fall back to opening a browser. The agent can read
the structured error and decide whether to install WebView2 Runtime, use the
browser debug page, or continue headlessly.

## Runtime Distribution

Alpha:

```text
require Evergreen WebView2 Runtime
document install requirement
fail with webview2_runtime_missing if unavailable
```

Do not silently download installers from the CLI in alpha.

Later installer:

```text
detect runtime during installer/update
use Evergreen Bootstrapper for online installs
use Evergreen Standalone Installer for offline lab machines
```

Do not use Fixed Version Runtime for the alpha package. Microsoft notes that
Fixed Version gives more control over update timing but adds a large runtime
payload. That is the wrong tradeoff for a small MCP/CLI alpha.

## TypeScript Integration

Update `src/app/gate-editor/native-window.ts`:

```ts
export type NativeGateEditorWindow = {
  runtime: "macos_wkwebview" | "windows_webview2";
  pid?: number;
  ready: Promise<void>;
  wait(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  close(): void;
};
```

Support check:

```ts
export function supportsNativeGateEditorWindow(): boolean {
  return process.platform === "darwin" || process.platform === "win32";
}
```

Launch dispatch:

```ts
if (process.platform === "darwin") return launchMacWebKitWindow(options);
if (process.platform === "win32") return launchWindowsWebView2Window(options);
throw native_window_unsupported;
```

Windows helper resolution:

```text
dist/native/windows/<arch>/flowcyto-webview2-window.exe
```

Architecture mapping:

```text
x64   -> win-x64
arm64 -> win-arm64
```

The npm package should include:

```json
{
  "files": [
    "dist/src/**/*",
    "dist/native/windows/**/*"
  ]
}
```

Only add the native binary to package output after it is built in CI. Source
stays under `native/windows/`.

## Build Scripts

Add scripts after the helper source exists:

```json
{
  "scripts": {
    "build:native:windows:x64": "dotnet publish native/windows/FlowcytoGateEditorWindow/FlowcytoGateEditorWindow.csproj -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -o dist/native/windows/win-x64",
    "build:native:windows:arm64": "dotnet publish native/windows/FlowcytoGateEditorWindow/FlowcytoGateEditorWindow.csproj -c Release -r win-arm64 --self-contained false -p:PublishSingleFile=true -o dist/native/windows/win-arm64"
  }
}
```

Release builds should run on Windows. Do not require macOS developers to build
Windows native binaries locally.

## Testing

Unit tests on every platform:

```text
native-window.ts dispatches win32 to windows_webview2
helper path resolution maps x64 and arm64
unsupported platforms return native_window_unsupported
Windows helper source contains ready/error stdout tokens
CLI doctor reports native_preview detail as windows_webview2 on Windows when helper exists
```

Windows integration tests:

```text
npm run build
npm run build:native:windows:x64
flowcyto doctor
flowcyto open-gate-editor-window <workspace>
assert JSON surface.runtime === windows_webview2
assert helper prints flowcyto_native_window_ready
assert /api/health returns ok while window is open
close window and assert local server exits
```

Manual Windows test:

```text
Windows 11
Node 20+
WebView2 Evergreen Runtime installed
install tarball
flowcyto doctor
flowcyto init sample run
flowcyto open-gate-editor-window run/flowcyto.workspace.json
draw rectangle gate
save gate
verify workspace revision increments
agent writes second gate
verify open window refreshes without manual reload
```

## CI

Add a Windows CI job after the helper exists:

```text
windows-latest
node 20
dotnet 8 SDK
npm ci
npm run fixtures:fetch
npm run build
npm run build:native:windows:x64
npm test
```

Native window UI automation may be fragile in CI. Keep full human-window testing
as a release checklist until CI has a reliable desktop session. The non-UI
helper build and TypeScript contract tests should still run in CI.

## Security

The native helper should only accept local preview URLs:

```text
http://127.0.0.1:<port>/mcp-app-preview
http://localhost:<port>/mcp-app-preview
```

Reject other URLs with:

```text
native_window_url_not_local
```

Do not let the helper become a general-purpose browser.

Do not expose `flowcyto-mcp --http` publicly as part of Windows parity. Native
window parity is still a localhost UI path.

## Acceptance Criteria

Windows parity is done when:

```text
flowcyto open-gate-editor-window works on Windows 11
the surface is a compact WebView2 window, not a browser tab
the same /mcp-app-preview bridge is used
human gate save increments workspace revision
agent-written gate appears in the open window without manual reload
missing WebView2 Runtime returns webview2_runtime_missing
browser debug page remains separate
macOS WKWebView path still passes
npm pack includes the Windows helper binary only from build output
```

## Non-Goals

Do not implement these as part of Windows parity:

```text
Electron shell
Tauri migration
full desktop app packaging
auto-update system
Windows installer
public HTTP exposure
FlowJo workspace import/export
new cytometry computation engine
```

Those are separate product milestones.
