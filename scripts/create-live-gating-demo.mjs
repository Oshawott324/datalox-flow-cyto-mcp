#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const defaultTarget = path.resolve(repoRoot, "..", "flowcyto-live-gating");
const defaultFixture = path.join(repoRoot, "testdata", "fixtures", "CFP_Well_A4.fcs");

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeText(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${value.trimEnd()}\n`, "utf8");
}

async function removeOldDemoArtifacts(targetDir) {
  for (const entry of [
    "scripts",
    "prompts",
    ".datalox",
    "agent-wiki",
    ".claude",
    ".cursor",
    ".github",
    ".windsurf",
    "bin",
    "skills",
    "AGENTS.md",
    "CLAUDE.md",
    "DATALOX.md",
    "GEMINI.md",
    "START_HERE.md",
    "WIKI.md",
  ]) {
    await rm(path.join(targetDir, entry), { recursive: true, force: true });
  }
}

function workspaceJson() {
  return JSON.stringify({
    version: 1,
    revision: 0,
    samples: [
      {
        id: "sample_001",
        path: "data/sample_001.fcs",
      },
    ],
    views: [
      {
        id: "main_population_fsc_ssc",
        sample: "sample_001",
        parent: "root",
        x: "FSC-A",
        y: "SSC-A",
        scale: {
          x: "linear",
          y: "linear",
        },
      },
    ],
    gates: [],
  }, null, 2);
}

function mcpJson() {
  return JSON.stringify({
    mcpServers: {
      flowcyto: {
        command: "node",
        args: [
          path.join(repoRoot, "dist", "src", "mcp", "server.js"),
        ],
      },
    },
  }, null, 2);
}

function readmeText(targetDir, noAgents) {
  if (noAgents) {
    return `# flowcyto-live-gating

Disposable Flowcyto data repo for validating an MCP host against a real FCS
file and canonical workspace artifact.

## Files

\`\`\`text
flowcyto.workspace.json
data/sample_001.fcs
.mcp.json
README.md
\`\`\`

The workspace starts at revision 0 and contains no gates. The local MCP
registration is in:

\`\`\`text
${path.join(targetDir, ".mcp.json")}
\`\`\`

Build Flowcyto MCP from the source repo before using this local registration:

\`\`\`bash
cd ${repoRoot}
npm run build
\`\`\`

Manual validation:

\`\`\`bash
node ${path.join(repoRoot, "dist", "src", "cli", "main.js")} validate flowcyto.workspace.json
node ${path.join(repoRoot, "dist", "src", "cli", "main.js")} read-workspace flowcyto.workspace.json
\`\`\`
`;
  }
  return `# flowcyto-live-gating

Disposable demo repo for proving the real Flowcyto MCP live gating loop.

This repo intentionally contains only data, the workspace artifact, MCP
registration, and agent instructions. It does not contain a gate writer script.
The agent must use Flowcyto MCP tools.

## Exact Demo Prompt

\`\`\`text
Open this FCS/workspace and gate the main population.
\`\`\`

## Expected Tool Trace

\`\`\`text
flowcyto.open_gate_editor
flowcyto.get_plot_context
flowcyto.upsert_gate
flowcyto.get_workspace_revision or flowcyto.read_workspace
\`\`\`

The compact app must open from the \`open_gate_editor\` tool call. The already-open
app must show the agent-written gate without a manual reload.

## Files

\`\`\`text
flowcyto.workspace.json
data/sample_001.fcs
.mcp.json
AGENTS.md
README.md
\`\`\`

The workspace starts at revision 0 and contains no gates.

## Prerequisites

Build Flowcyto MCP from the source repo:

\`\`\`bash
cd ${repoRoot}
npm run build
\`\`\`

The local MCP registration is in:

\`\`\`text
${path.join(targetDir, ".mcp.json")}
\`\`\`

For Codex or Claude Code style hosts that do not render MCP Apps resources yet,
the agent should call:

\`\`\`text
open_gate_editor(surface="native_window")
\`\`\`

For MCP Apps capable hosts, the agent can use:

\`\`\`text
open_gate_editor(surface="mcp_app")
\`\`\`

## Manual Validation

From this repo:

\`\`\`bash
node ${path.join(repoRoot, "dist", "src", "cli", "main.js")} validate flowcyto.workspace.json
node ${path.join(repoRoot, "dist", "src", "cli", "main.js")} read-workspace flowcyto.workspace.json
\`\`\`

After the demo turn:

- \`revision\` increments from 0 to 1.
- One gate exists in \`flowcyto.workspace.json\`.
- The open compact app shows that gate without reload.
- No browser debug page is opened.
- No host app source code is modified.

## Reset

Recreate this disposable repo from the Flowcyto MCP source repo:

\`\`\`bash
cd ${repoRoot}
node scripts/create-live-gating-demo.mjs --target ${targetDir} --force
\`\`\`
`;
}

function agentsText(targetDir) {
  const workspacePath = path.join(targetDir, "flowcyto.workspace.json");
  return `# Flowcyto Live Gating Agent Instructions

This repo is a disposable Flowcyto MCP demo workspace.

The user-facing demo prompt is:

\`\`\`text
Open this FCS/workspace and gate the main population.
\`\`\`

Use the Flowcyto MCP server registered in \`.mcp.json\`. Follow the
\`nextAction\` fields returned by Flowcyto tools.

If the Flowcyto MCP server is unavailable, stop and report that the MCP server
must be registered from \`.mcp.json\`.

Canonical workspace:

\`\`\`text
${workspacePath}
\`\`\`

Pass criteria:

- The compact app opens from the MCP tool call.
- The Flowcyto tool result chain is followed through \`nextAction\`.
- A single gate is written through Flowcyto MCP tools.
- The workspace revision increments exactly once for the agent gate write.
`;
}

const targetDir = path.resolve(argValue("--target", defaultTarget));
const fixturePath = path.resolve(argValue("--fixture", defaultFixture));
const force = process.argv.includes("--force");
const noAgents = process.argv.includes("--no-agents");

if ((await exists(targetDir)) && !force) {
  throw new Error(`Target already exists: ${targetDir}. Pass --force to refresh known demo files.`);
}

if (!(await exists(fixturePath))) {
  throw new Error(`FCS fixture not found: ${fixturePath}`);
}

await mkdir(targetDir, { recursive: true });
await removeOldDemoArtifacts(targetDir);
await mkdir(path.join(targetDir, "data"), { recursive: true });
await copyFile(fixturePath, path.join(targetDir, "data", "sample_001.fcs"));

await writeText(path.join(targetDir, "flowcyto.workspace.json"), workspaceJson());
await writeText(path.join(targetDir, ".mcp.json"), mcpJson());
await writeText(path.join(targetDir, ".gitignore"), `.DS_Store
.datalox/
agent-wiki/
node_modules/
`);
await writeText(path.join(targetDir, "README.md"), readmeText(targetDir, noAgents));
if (!noAgents) {
  await writeText(path.join(targetDir, "AGENTS.md"), agentsText(targetDir));
}

if (!(await exists(path.join(targetDir, ".git")))) {
  execFileSync("git", ["init"], { cwd: targetDir, stdio: "ignore" });
}

const workspace = JSON.parse(await readFile(path.join(targetDir, "flowcyto.workspace.json"), "utf8"));
process.stdout.write(JSON.stringify({
  ok: true,
  targetDir,
  workspacePath: path.join(targetDir, "flowcyto.workspace.json"),
  samplePath: path.join(targetDir, "data", "sample_001.fcs"),
  mcpConfigPath: path.join(targetDir, ".mcp.json"),
  agentsPath: noAgents ? null : path.join(targetDir, "AGENTS.md"),
  revision: workspace.revision,
  gateCount: workspace.gates.length,
}, null, 2) + "\n");
