#!/usr/bin/env node
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);
const gateEditorResourceUri = "ui://flowcyto/gate-editor-v1.html";

function npmInvocation(args) {
  return process.platform === "win32"
    ? { command: "cmd", args: ["/c", "npm", ...args] }
    : { command: "npm", args };
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

async function execJson(command, args) {
  const { stdout } = await execFileAsync(command, args, {
    cwd: process.cwd(),
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function createPackage() {
  const npm = npmInvocation(["pack", "--json"]);
  const packed = await execJson(npm.command, npm.args);
  const filename = packed?.[0]?.filename;
  if (typeof filename !== "string" || filename.length === 0) {
    throw new Error("npm pack --json did not return a package filename.");
  }
  return path.resolve(filename);
}

function requireTool(tools, name) {
  if (!tools.tools.some((tool) => tool.name === name)) {
    throw new Error(`Packed MCP server did not expose required tool: ${name}`);
  }
}

const providedPackage = argValue("--package", undefined);
const keepTarball = hasFlag("--keep-tarball");
const packageSpec = providedPackage ? path.resolve(providedPackage) : await createPackage();
const shouldRemovePackage = !providedPackage && !keepTarball;

try {
  const doctorNpm = npmInvocation([
    "exec",
    "--yes",
    "--package",
    packageSpec,
    "--",
    "flowcyto",
    "doctor",
  ]);
  const doctor = await execJson(doctorNpm.command, doctorNpm.args);
  if (!doctor.ok) {
    throw new Error(`flowcyto doctor failed for packed package: ${JSON.stringify(doctor, null, 2)}`);
  }

  const client = new Client({ name: "flowcyto-package-smoke", version: "0.1.0" });
  const mcpNpm = npmInvocation([
    "exec",
    "--yes",
    "--package",
    packageSpec,
    "--",
    "flowcyto-mcp",
  ]);
  const transport = new StdioClientTransport({
    command: mcpNpm.command,
    args: mcpNpm.args,
  });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    requireTool(tools, "open_fcs");
    requireTool(tools, "render_plot");
    requireTool(tools, "render_plot_image");
    requireTool(tools, "open_gate_editor");
    requireTool(tools, "get_plot_context");
    requireTool(tools, "upsert_gate");

    const resource = await client.readResource({ uri: gateEditorResourceUri });
    const firstContent = resource.contents[0];
    if (firstContent?.mimeType !== "text/html;profile=mcp-app") {
      throw new Error(`Unexpected gate editor resource MIME type: ${firstContent?.mimeType ?? "missing"}`);
    }
    const capabilities = await client.readResource({ uri: "flowcyto://capabilities" });
    const capabilitiesText = "text" in capabilities.contents[0] ? capabilities.contents[0].text : "";
    if (!capabilitiesText.includes(".fcs") || !capabilitiesText.includes("canRenderPlots")) {
      throw new Error("Packed MCP server did not expose Flowcyto capabilities resource.");
    }

    const prompts = await client.listPrompts();
    if (!prompts.prompts.some((prompt) => prompt.name === "open-fcs-and-gate-main-population")) {
      throw new Error("Packed MCP server did not expose open-fcs-and-gate-main-population prompt.");
    }
  } finally {
    await client.close();
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    package: packageSpec,
    checked: [
      "flowcyto doctor",
      "flowcyto-mcp initialize",
      "tools/list",
      "resources/read ui://flowcyto/gate-editor-v1.html",
      "resources/read flowcyto://capabilities",
      "prompts/list",
    ],
  }, null, 2)}\n`);
} finally {
  if (shouldRemovePackage) {
    await rm(packageSpec, { force: true });
  }
}
