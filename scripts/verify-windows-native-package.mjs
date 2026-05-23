#!/usr/bin/env node
import { access, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

const arch = process.argv[2] ?? "win-x64";
if (arch !== "win-x64" && arch !== "win-arm64") {
  throw new Error(`Unsupported Windows native arch: ${arch}`);
}

const root = path.resolve("dist", "native", "windows", arch);
const exePath = path.join(root, "flowcyto-webview2-window.exe");
const loaderPath = path.join(root, "WebView2Loader.dll");
const runtimeLoaderPath = path.join(root, "runtimes", arch, "native", "WebView2Loader.dll");
const buildLoaderPath = path.resolve(
  "native",
  "windows",
  "FlowcytoGateEditorWindow",
  "bin",
  "Release",
  "net8.0-windows",
  arch,
  "WebView2Loader.dll",
);

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(exePath))) {
  throw new Error(`Missing Windows WebView2 helper executable: ${exePath}`);
}

if (!(await exists(loaderPath)) && await exists(runtimeLoaderPath)) {
  await mkdir(path.dirname(loaderPath), { recursive: true });
  await copyFile(runtimeLoaderPath, loaderPath);
}

if (!(await exists(loaderPath)) && await exists(buildLoaderPath)) {
  await mkdir(path.dirname(loaderPath), { recursive: true });
  await copyFile(buildLoaderPath, loaderPath);
}

if (!(await exists(loaderPath))) {
  throw new Error(`Missing Windows WebView2Loader.dll beside helper executable: ${loaderPath}`);
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  arch,
  checked: [exePath, loaderPath],
}, null, 2)}\n`);
