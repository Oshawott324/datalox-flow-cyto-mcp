import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { FlowcytoError } from "../../core/index.js";

const READY_TOKEN = "flowcyto_native_window_ready";
const ERROR_PREFIX = "flowcyto_native_window_error ";

export type NativeGateEditorWindowOptions = {
  url: string;
  title?: string;
  width?: number;
  height?: number;
};

export type NativeGateEditorRuntime = "macos_wkwebview" | "windows_webview2";

export type NativeGateEditorWindow = {
  runtime: NativeGateEditorRuntime;
  pid?: number;
  ready: Promise<void>;
  wait(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  close(): void;
};

export type NativeGateEditorReadiness = {
  ok: boolean;
  detail: string;
  runtime: NativeGateEditorRuntime | null;
  helperPath?: string;
  loaderPath?: string;
};

export type NativeGateEditorLaunchPlan = {
  runtime: NativeGateEditorRuntime;
  runtimeLabel: "WebKit" | "WebView2";
  command: string;
  args: string[];
  windowsHide?: boolean;
};

type NativeWindowErrorPayload = {
  code: string;
  path: string;
  message: string;
};

export function nativeGateEditorRuntimeForPlatform(platform: NodeJS.Platform = process.platform): NativeGateEditorRuntime | null {
  if (platform === "darwin") return "macos_wkwebview";
  if (platform === "win32") return "windows_webview2";
  return null;
}

export function supportsNativeGateEditorWindow(platform: NodeJS.Platform = process.platform): boolean {
  return nativeGateEditorRuntimeForPlatform(platform) !== null;
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

function packageRootFromModule(startDir = path.dirname(fileURLToPath(import.meta.url))): string {
  let current = startDir;
  for (;;) {
    if (existsSync(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

function windowsRuntimeArch(arch: NodeJS.Architecture = process.arch): "win-x64" | "win-arm64" {
  if (arch === "x64") return "win-x64";
  if (arch === "arm64") return "win-arm64";
  throw new FlowcytoError(
    "windows_webview2_arch_unsupported",
    `Windows WebView2 native preview only supports x64 and arm64 builds; received ${arch}.`,
    "/surface/runtime",
  );
}

export function windowsWebView2HelperPath(
  arch: NodeJS.Architecture = process.arch,
  packageRoot = packageRootFromModule(),
): string {
  return path.join(
    packageRoot,
    "dist",
    "native",
    "windows",
    windowsRuntimeArch(arch),
    "flowcyto-webview2-window.exe",
  );
}

export function windowsWebView2LoaderPath(
  arch: NodeJS.Architecture = process.arch,
  packageRoot = packageRootFromModule(),
): string {
  return path.join(
    packageRoot,
    "dist",
    "native",
    "windows",
    windowsRuntimeArch(arch),
    "WebView2Loader.dll",
  );
}

export function nativeGateEditorReadiness(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
  packageRoot = packageRootFromModule(),
): NativeGateEditorReadiness {
  const runtime = nativeGateEditorRuntimeForPlatform(platform);
  if (runtime === "macos_wkwebview") {
    return { ok: true, detail: runtime, runtime };
  }
  if (runtime === "windows_webview2") {
    const helperPath = windowsWebView2HelperPath(arch, packageRoot);
    const loaderPath = windowsWebView2LoaderPath(arch, packageRoot);
    if (!existsSync(helperPath)) {
      return { ok: false, detail: "windows_webview2_helper_missing", runtime, helperPath, loaderPath };
    }
    if (!existsSync(loaderPath)) {
      return { ok: false, detail: "windows_webview2_loader_missing", runtime, helperPath, loaderPath };
    }
    return { ok: true, detail: runtime, runtime, helperPath, loaderPath };
  }
  return { ok: false, detail: "unsupported_platform", runtime: null };
}

export function nativeGateEditorReadinessError(readiness: NativeGateEditorReadiness = nativeGateEditorReadiness()): FlowcytoError | null {
  if (readiness.ok) return null;
  if (readiness.detail === "unsupported_platform") {
    return new FlowcytoError(
      "native_window_unsupported",
      "The local native gate editor window requires macOS WebKit or Windows WebView2.",
      "/surface",
    );
  }
  if (readiness.detail === "windows_webview2_helper_missing") {
    return new FlowcytoError(
      "windows_webview2_helper_missing",
      `Windows WebView2 helper was not found at ${readiness.helperPath}. Run the Windows native build before packaging.`,
      "/surface/runtime",
    );
  }
  if (readiness.detail === "windows_webview2_loader_missing") {
    return new FlowcytoError(
      "windows_webview2_loader_missing",
      `Windows WebView2Loader.dll was not found beside the native helper executable at ${readiness.loaderPath}. Rebuild or repair the Windows native package.`,
      "/surface/runtime",
    );
  }
  return new FlowcytoError("native_window_failed", `Native gate editor is not ready: ${readiness.detail}.`, "/surface/runtime");
}

export function parseNativeWindowErrorPayload(raw: string): NativeWindowErrorPayload {
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed) as Partial<NativeWindowErrorPayload>;
    if (typeof parsed.code === "string" && typeof parsed.message === "string") {
      return {
        code: parsed.code,
        path: typeof parsed.path === "string" ? parsed.path : "/surface",
        message: parsed.message,
      };
    }
  } catch {
    // macOS JXA currently reports plain text after the shared error prefix.
  }
  return {
    code: "native_window_failed",
    path: "/surface",
    message: trimmed || "Native gate editor window failed.",
  };
}

export function macGateEditorWindowScript(): string {
  return `
ObjC.import("Cocoa");
ObjC.import("WebKit");

let flowcytoWindow;
let flowcytoWebView;
let flowcytoWindowDelegate;

ObjC.registerSubclass({
  name: "FlowcytoWindowDelegate",
  protocols: ["NSWindowDelegate"],
  methods: {
    "windowWillClose:": {
      types: ["void", ["id"]],
      implementation: function windowWillClose(_notification) {
        $.NSApp.terminate(null);
      }
    }
  }
});

function writeStdout(text) {
  const data = $(text).dataUsingEncoding($.NSUTF8StringEncoding);
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(data);
}

function run(argv) {
  try {
    const url = argv[0];
    const title = argv[1] || "Flowcyto Gate Editor";
    const width = Number(argv[2] || "620");
    const height = Number(argv[3] || "620");

    const app = $.NSApplication.sharedApplication;
    app.setActivationPolicy($.NSApplicationActivationPolicyRegular);

    const rect = $.NSMakeRect(0, 0, width, height);
    const style =
      $.NSWindowStyleMaskTitled |
      $.NSWindowStyleMaskClosable |
      $.NSWindowStyleMaskMiniaturizable |
      $.NSWindowStyleMaskResizable;

    flowcytoWindow = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
      rect,
      style,
      $.NSBackingStoreBuffered,
      false
    );
    flowcytoWindow.setTitle($(title));
    flowcytoWindow.center;

    const config = $.WKWebViewConfiguration.alloc.init;
    flowcytoWebView = $.WKWebView.alloc.initWithFrameConfiguration(rect, config);
    flowcytoWebView.setAutoresizingMask($.NSViewWidthSizable | $.NSViewHeightSizable);
    flowcytoWindow.setContentView(flowcytoWebView);

    flowcytoWindowDelegate = $.FlowcytoWindowDelegate.alloc.init;
    flowcytoWindow.setDelegate(flowcytoWindowDelegate);

    const request = $.NSURLRequest.requestWithURL($.NSURL.URLWithString($(url)));
    flowcytoWebView.loadRequest(request);
    flowcytoWindow.makeKeyAndOrderFront(null);
    app.activateIgnoringOtherApps(true);

    writeStdout("${READY_TOKEN}\\n");
    app.run;
  } catch (error) {
    writeStdout("flowcyto_native_window_error " + String(error) + "\\n");
    throw error;
  }
}
`;
}

function nativeWindowError(message: string): FlowcytoError {
  return new FlowcytoError("native_window_failed", message, "/surface");
}

export function launchNativeGateEditorWindow(options: NativeGateEditorWindowOptions): NativeGateEditorWindow {
  const plan = nativeGateEditorLaunchPlan(options);
  const child: ChildProcess = spawn(plan.command, plan.args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: plan.windowsHide,
  });
  return wrapNativeWindowChild(child, plan.runtime, plan.runtimeLabel);
}

export function nativeGateEditorLaunchPlan(
  options: NativeGateEditorWindowOptions,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
  packageRoot = packageRootFromModule(),
): NativeGateEditorLaunchPlan {
  if (!isLocalGateEditorPreviewUrl(options.url)) {
    throw new FlowcytoError(
      "native_window_url_not_local",
      "Native gate editor windows only accept the local /mcp-app-preview URL.",
      "/surface/url",
    );
  }

  const runtime = nativeGateEditorRuntimeForPlatform(platform);
  if (runtime === "macos_wkwebview") {
    return {
      runtime,
      runtimeLabel: "WebKit",
      command: "osascript",
      args: [
        "-l",
        "JavaScript",
        "-e",
        macGateEditorWindowScript(),
        options.url,
        options.title ?? "Flowcyto Gate Editor",
        String(options.width ?? 620),
        String(options.height ?? 620),
      ],
    };
  }

  if (runtime === "windows_webview2") {
    const helperPath = windowsWebView2HelperPath(arch, packageRoot);
    const loaderPath = windowsWebView2LoaderPath(arch, packageRoot);
    if (!existsSync(helperPath)) {
      throw new FlowcytoError(
        "windows_webview2_helper_missing",
        `Windows WebView2 helper was not found at ${helperPath}. Run the Windows native build before packaging.`,
        "/surface/runtime",
      );
    }
    if (!existsSync(loaderPath)) {
      throw new FlowcytoError(
        "windows_webview2_loader_missing",
        `Windows WebView2Loader.dll was not found beside the native helper executable at ${loaderPath}. Rebuild or repair the Windows native package.`,
        "/surface/runtime",
      );
    }
    return {
      runtime,
      runtimeLabel: "WebView2",
      command: helperPath,
      args: [
        options.url,
        options.title ?? "Flowcyto Gate Editor",
        String(options.width ?? 620),
        String(options.height ?? 620),
      ],
      windowsHide: true,
    };
  }

  throw new FlowcytoError(
    "native_window_unsupported",
    "The local native gate editor window requires macOS WebKit or Windows WebView2.",
    "/surface",
  );
}

function extractNativeWindowError(stdout: string): FlowcytoError | null {
  const start = stdout.indexOf(ERROR_PREFIX);
  if (start < 0) return null;
  const rest = stdout.slice(start + ERROR_PREFIX.length);
  const line = rest.split(/\r?\n/, 1)[0]?.trim();
  if (!line) return null;
  const parsed = parseNativeWindowErrorPayload(line);
  return new FlowcytoError(parsed.code, parsed.message, parsed.path);
}

function wrapNativeWindowChild(
  child: ChildProcess,
  runtime: NativeGateEditorRuntime,
  runtimeLabel: string,
): NativeGateEditorWindow {
  const stderrChunks: string[] = [];
  let stdout = "";
  let readySettled = false;

  child.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk.toString("utf8"));
  });

  const stderrText = () => stderrChunks.join("").trim();

  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!child.killed) child.kill("SIGTERM");
      fail(nativeWindowError(`Timed out waiting for the native ${runtimeLabel} window to report readiness.`));
    }, 5_000);
    const fail = (error: unknown) => {
      if (readySettled) return;
      readySettled = true;
      clearTimeout(timer);
      reject(error);
    };
    const pass = () => {
      if (readySettled) return;
      readySettled = true;
      clearTimeout(timer);
      resolve();
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const error = extractNativeWindowError(stdout);
      if (error) fail(error);
      if (stdout.includes(READY_TOKEN)) pass();
    });
    child.once("error", (error) => {
      fail(nativeWindowError(error.message));
    });
    child.once("exit", (code, signal) => {
      if (readySettled) return;
      const detail = stderrText() || `${runtimeLabel} launcher exited before opening the window: code=${code ?? "null"} signal=${signal ?? "null"}`;
      fail(nativeWindowError(detail));
    });
  });

  const wait = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", (error) => {
      reject(nativeWindowError(error.message));
    });
    child.once("exit", (code, signal) => {
      if (code === 0 || signal === "SIGTERM") {
        resolve({ code, signal });
        return;
      }
      const detail = stderrText() || `${runtimeLabel} launcher exited with code=${code ?? "null"} signal=${signal ?? "null"}`;
      reject(nativeWindowError(detail));
    });
  });

  return {
    runtime,
    pid: child.pid,
    ready,
    wait: () => wait,
    close: () => {
      if (!child.killed) child.kill("SIGTERM");
    },
  };
}
