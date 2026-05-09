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
https://learn.microsoft.com/en-us/microsoft-edge/webview2/get-started/winforms
https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder
```

Concrete meaning of "thin native WebView2 helper":

```text
the helper is a window host, not a product runtime
the helper receives one already-running localhost URL from TypeScript
the helper validates that URL is local
the helper creates one WinForms window
the helper creates one WebView2 control
the helper loads /mcp-app-preview
the helper prints one readiness token or one structured error
the helper exits when the user closes the window
```

It must not contain cytometry-specific state beyond the title string. No FCS
paths, sample IDs, gates, marker names, workspace JSON, preview bins, or MCP
tool names should cross into the C# process. That keeps the Windows path equal
to the macOS `WKWebView` path: a local view container around the existing app.

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

## Concrete Implementation Plan

Implement this as a small, reviewable runtime slice rather than a desktop app.

Files to add:

```text
native/windows/FlowcytoGateEditorWindow/FlowcytoGateEditorWindow.csproj
native/windows/FlowcytoGateEditorWindow/Program.cs
native/windows/FlowcytoGateEditorWindow/MainForm.cs
```

Files to change:

```text
src/app/gate-editor/native-window.ts
src/cli/main.ts
tests/core.test.ts
package.json
README.md
docs/implementation-details.md
```

Build outputs:

```text
dist/native/windows/win-x64/flowcyto-webview2-window.exe
dist/native/windows/win-arm64/flowcyto-webview2-window.exe
```

### Native Helper Contract

The helper process is invoked by TypeScript, not by users directly:

```text
flowcyto-webview2-window.exe <url> <title> <width> <height>
```

Required argument rules:

```text
url    absolute http URL, local only, path must be /mcp-app-preview
title  plain window title
width  integer, 360 <= width <= 2200
height integer, 360 <= height <= 1800
```

Allowed URLs:

```text
http://127.0.0.1:<port>/mcp-app-preview
http://localhost:<port>/mcp-app-preview
```

Rejected URLs:

```text
https://...
http://0.0.0.0:...
http://192.168.x.x:...
http://example.com/...
file://...
anything whose path is not /mcp-app-preview
```

Stdout lines are the process API:

```text
flowcyto_native_window_ready
flowcyto_native_window_error {"code":"webview2_runtime_missing","path":"/surface/runtime","message":"Microsoft Edge WebView2 Runtime is required for the Windows native gate editor window."}
```

The TypeScript parent watches stdout for the ready token. If it sees an error
line, it parses the JSON after the prefix and returns a `FlowcytoError` with the
same `code`, `path`, and `message`.

### C# Project

Use WinForms because this helper needs one native window and one WebView2
control. It does not need WPF layout, Electron, Tauri, menus, auto-update, or a
plugin framework.

Initial `FlowcytoGateEditorWindow.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0-windows</TargetFramework>
    <UseWindowsForms>true</UseWindowsForms>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <AssemblyName>flowcyto-webview2-window</AssemblyName>
    <RootNamespace>FlowcytoGateEditorWindow</RootNamespace>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.Web.WebView2" Version="1.0.3537.50" />
  </ItemGroup>
</Project>
```

The WebView2 SDK version must be pinned in committed code. Upgrade it only as an
explicit dependency-maintenance change.

Use `OutputType=Exe` because the TypeScript parent needs a reliable stdout pipe
for the ready/error protocol. The Node launcher should set `windowsHide: true`
so the console window is hidden while the WinForms window is still shown.

### Program.cs

`Program.cs` should only parse arguments, validate the local URL, and start the
form.

```csharp
using System.Text.Json;

namespace FlowcytoGateEditorWindow;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        if (!TryParseArgs(args, out var options, out var error))
        {
            WriteError(error);
            Environment.Exit(2);
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm(options));
    }

    private static bool TryParseArgs(
        string[] args,
        out WindowOptions options,
        out NativeWindowError error)
    {
        options = default!;
        error = default!;

        if (args.Length < 1)
        {
            error = NativeWindowError.InvalidArgs("Missing /mcp-app-preview URL.");
            return false;
        }

        if (!Uri.TryCreate(args[0], UriKind.Absolute, out var uri) || !IsAllowedPreviewUri(uri))
        {
            error = new NativeWindowError(
                "native_window_url_not_local",
                "/surface/url",
                "Windows native preview only accepts http://127.0.0.1:<port>/mcp-app-preview or http://localhost:<port>/mcp-app-preview.");
            return false;
        }

        var title = args.Length > 1 && args[1].Length > 0
            ? args[1]
            : "Flowcyto Gate Editor";

        var width = ParseBoundedInt(args, 2, 620, 360, 2200);
        var height = ParseBoundedInt(args, 3, 640, 360, 1800);

        options = new WindowOptions(uri, title, width, height);
        return true;
    }

    private static int ParseBoundedInt(string[] args, int index, int fallback, int min, int max)
    {
        if (args.Length <= index || !int.TryParse(args[index], out var value))
        {
            return fallback;
        }

        return Math.Clamp(value, min, max);
    }

    private static bool IsAllowedPreviewUri(Uri uri)
    {
        return uri.Scheme == Uri.UriSchemeHttp
            && uri.AbsolutePath == "/mcp-app-preview"
            && (uri.Host == "127.0.0.1" || uri.Host == "localhost")
            && !uri.IsDefaultPort;
    }

    internal static void WriteReady()
    {
        Console.Out.WriteLine("flowcyto_native_window_ready");
        Console.Out.Flush();
    }

    internal static void WriteError(NativeWindowError error)
    {
        Console.Out.Write("flowcyto_native_window_error ");
        Console.Out.WriteLine(JsonSerializer.Serialize(error));
        Console.Out.Flush();
    }
}

internal sealed record WindowOptions(Uri Url, string Title, int Width, int Height);

internal sealed record NativeWindowError(string code, string path, string message)
{
    public static NativeWindowError InvalidArgs(string message)
        => new("native_window_invalid_args", "/surface", message);
}
```

### MainForm.cs

`MainForm` owns the UI host. Keep it intentionally boring.

```csharp
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace FlowcytoGateEditorWindow;

internal sealed class MainForm : Form
{
    private readonly WindowOptions _options;
    private readonly WebView2 _webView;
    private bool _readyWritten;

    public MainForm(WindowOptions options)
    {
        _options = options;

        Text = options.Title;
        StartPosition = FormStartPosition.CenterScreen;
        Width = options.Width;
        Height = options.Height;
        MinimumSize = new Size(360, 360);

        _webView = new WebView2
        {
            Dock = DockStyle.Fill,
            AllowExternalDrop = false
        };

        Controls.Add(_webView);
        Shown += async (_, _) => await InitializeWebViewAsync();
    }

    private async Task InitializeWebViewAsync()
    {
        try
        {
            var runtimeVersion = CoreWebView2Environment.GetAvailableBrowserVersionString();
            if (string.IsNullOrWhiteSpace(runtimeVersion))
            {
                Program.WriteError(new NativeWindowError(
                    "webview2_runtime_missing",
                    "/surface/runtime",
                    "Microsoft Edge WebView2 Runtime is required for the Windows native gate editor window."));
                Close();
                return;
            }

            var userDataFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Datalox",
                "FlowcytoMcp",
                "WebView2");

            Directory.CreateDirectory(userDataFolder);

            var environment = await CoreWebView2Environment.CreateAsync(
                browserExecutableFolder: null,
                userDataFolder: userDataFolder,
                options: null);

            await _webView.EnsureCoreWebView2Async(environment);

            _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            _webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
            _webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
            _webView.CoreWebView2.Settings.IsZoomControlEnabled = true;

            _webView.CoreWebView2.NavigationStarting += (_, args) =>
            {
                if (!IsAllowedPreviewUri(new Uri(args.Uri)))
                {
                    args.Cancel = true;
                }
            };

            _webView.CoreWebView2.NavigationCompleted += (_, args) =>
            {
                if (_readyWritten) return;
                _readyWritten = true;

                if (args.IsSuccess)
                {
                    Program.WriteReady();
                    return;
                }

                Program.WriteError(new NativeWindowError(
                    "native_window_navigation_failed",
                    "/surface/url",
                    $"WebView2 failed to load the local preview URL: {args.WebErrorStatus}."));
                Close();
            };

            _webView.CoreWebView2.Navigate(_options.Url.ToString());
        }
        catch (WebView2RuntimeNotFoundException)
        {
            Program.WriteError(new NativeWindowError(
                "webview2_runtime_missing",
                "/surface/runtime",
                "Microsoft Edge WebView2 Runtime is required for the Windows native gate editor window."));
            Close();
        }
        catch (Exception error)
        {
            Program.WriteError(new NativeWindowError(
                "native_window_failed",
                "/surface",
                error.Message));
            Close();
        }
    }

    private static bool IsAllowedPreviewUri(Uri uri)
    {
        return uri.Scheme == Uri.UriSchemeHttp
            && uri.AbsolutePath == "/mcp-app-preview"
            && (uri.Host == "127.0.0.1" || uri.Host == "localhost")
            && !uri.IsDefaultPort;
    }
}
```

The duplicated URL check in `Program.cs` and `MainForm.cs` is deliberate. The
first check rejects bad startup input. The second prevents in-window navigation
from turning the helper into a general-purpose browser.

### TypeScript Launcher Changes

Refactor `src/app/gate-editor/native-window.ts` into small platform helpers.
Do not bury Windows rules inside the CLI command.

Add pure helpers so most Windows behavior can be tested on macOS/Linux:

```ts
export type NativeGateEditorRuntime = "macos_wkwebview" | "windows_webview2";

export function nativeGateEditorRuntimeForPlatform(platform = process.platform): NativeGateEditorRuntime | null {
  if (platform === "darwin") return "macos_wkwebview";
  if (platform === "win32") return "windows_webview2";
  return null;
}

export function isLocalGateEditorPreviewUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:"
      && url.pathname === "/mcp-app-preview"
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      && url.port.length > 0;
  } catch {
    return false;
  }
}

export function windowsWebView2HelperPath(
  arch = process.arch,
  baseDir = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url))),
): string {
  const runtimeArch = arch === "arm64" ? "win-arm64" : "win-x64";
  return path.join(baseDir, "dist", "native", "windows", runtimeArch, "flowcyto-webview2-window.exe");
}
```

Update the public type:

```ts
export type NativeGateEditorWindow = {
  runtime: NativeGateEditorRuntime;
  pid?: number;
  ready: Promise<void>;
  wait(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  close(): void;
};
```

Update support detection:

```ts
export function supportsNativeGateEditorWindow(): boolean {
  return nativeGateEditorRuntimeForPlatform() !== null;
}
```

Dispatch explicitly:

```ts
export function launchNativeGateEditorWindow(options: NativeGateEditorWindowOptions): NativeGateEditorWindow {
  const runtime = nativeGateEditorRuntimeForPlatform();

  if (runtime === "macos_wkwebview") {
    return launchMacWebKitWindow(options);
  }

  if (runtime === "windows_webview2") {
    return launchWindowsWebView2Window(options);
  }

  throw new FlowcytoError(
    "native_window_unsupported",
    "The local native gate editor window requires macOS WebKit or Windows WebView2.",
    "/surface",
  );
}
```

Windows launcher:

```ts
function launchWindowsWebView2Window(options: NativeGateEditorWindowOptions): NativeGateEditorWindow {
  if (!isLocalGateEditorPreviewUrl(options.url)) {
    throw new FlowcytoError(
      "native_window_url_not_local",
      "Windows native preview only accepts the local /mcp-app-preview URL.",
      "/surface/url",
    );
  }

  const helperPath = windowsWebView2HelperPath();
  if (!existsSync(helperPath)) {
    throw new FlowcytoError(
      "windows_webview2_helper_missing",
      `Windows WebView2 helper was not found at ${helperPath}. Run the Windows native build before packaging.`,
      "/surface/runtime",
    );
  }

  const child = spawn(helperPath, [
    options.url,
    options.title ?? "Flowcyto Gate Editor",
    String(options.width ?? 620),
    String(options.height ?? 640),
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  return wrapNativeWindowChild(child, "windows_webview2", "WebView2");
}
```

Then move the existing stdout/stderr ready handling into:

```ts
function wrapNativeWindowChild(
  child: ChildProcess,
  runtime: NativeGateEditorRuntime,
  runtimeLabel: string,
): NativeGateEditorWindow
```

That wrapper should:

```text
resolve ready when stdout contains flowcyto_native_window_ready
reject ready when stdout contains flowcyto_native_window_error <json>
include stderr in native_window_failed when the process exits early
kill the child on readiness timeout
return runtime from the wrapper argument
```

### CLI Doctor Changes

`flowcyto doctor` should report platform-specific native readiness:

```json
{
  "name": "native_preview",
  "ok": true,
  "detail": "windows_webview2"
}
```

If the helper is missing on Windows:

```json
{
  "name": "native_preview",
  "ok": false,
  "detail": "windows_webview2_helper_missing"
}
```

If WebView2 Runtime is missing, the helper is the authoritative detector. The
doctor command can either run the helper in a future `--deep` mode or leave this
as a launch-time structured error. For alpha, launch-time detection is enough.

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

The implementation details above are the source of truth for
`src/app/gate-editor/native-window.ts`. Keep the important seams testable as
pure functions:

```text
nativeGateEditorRuntimeForPlatform(platform)
isLocalGateEditorPreviewUrl(value)
windowsWebView2HelperPath(arch, baseDir)
wrapNativeWindowChild(child, runtime, runtimeLabel)
```

The npm package should include the helper binaries only after the Windows native
build has produced them:

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
