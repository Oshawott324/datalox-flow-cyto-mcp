import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";

import { FlowcytoError } from "../../core/index.js";

const READY_TOKEN = "flowcyto_native_window_ready";

export type NativeGateEditorWindowOptions = {
  url: string;
  title?: string;
  width?: number;
  height?: number;
};

export type NativeGateEditorWindow = {
  runtime: "macos_wkwebview";
  pid?: number;
  ready: Promise<void>;
  wait(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  close(): void;
};

export function supportsNativeGateEditorWindow(): boolean {
  return process.platform === "darwin";
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
  if (!supportsNativeGateEditorWindow()) {
    throw new FlowcytoError(
      "native_window_unsupported",
      "The local native gate editor window currently requires macOS WebKit.",
      "/surface",
    );
  }

  const child: ChildProcess = spawn("osascript", [
    "-l",
    "JavaScript",
    "-e",
    macGateEditorWindowScript(),
    options.url,
    options.title ?? "Flowcyto Gate Editor",
    String(options.width ?? 620),
    String(options.height ?? 620),
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });

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
      fail(nativeWindowError("Timed out waiting for the native WebKit window to report readiness."));
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
      if (stdout.includes(READY_TOKEN)) pass();
    });
    child.once("error", (error) => {
      fail(nativeWindowError(error.message));
    });
    child.once("exit", (code, signal) => {
      if (readySettled) return;
      const detail = stderrText() || `osascript exited before opening the window: code=${code ?? "null"} signal=${signal ?? "null"}`;
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
      const detail = stderrText() || `osascript exited with code=${code ?? "null"} signal=${signal ?? "null"}`;
      reject(nativeWindowError(detail));
    });
  });

  return {
    runtime: "macos_wkwebview",
    pid: child.pid,
    ready,
    wait: () => wait,
    close: () => {
      if (!child.killed) child.kill("SIGTERM");
    },
  };
}
