#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const defaultWorkspacePath = path.resolve("flowcyto.workspace.json");

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

function check(errors, condition, pathValue, code, message) {
  if (!condition) errors.push({ path: pathValue, code, message });
}

const workspacePath = path.resolve(argValue("--workspace", defaultWorkspacePath));
const expectedRevision = Number(argValue("--expected-revision", "1"));
const expectedGateId = argValue("--expected-gate-id", "agent_main_population_gate");
const expectedSample = argValue("--expected-sample", "sample_001");
const expectedX = argValue("--expected-x", "FSC-A");
const expectedY = argValue("--expected-y", "SSC-A");
const allowNoAgents = process.argv.includes("--allow-no-agents");

if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
  throw new Error("--expected-revision must be a non-negative integer.");
}

const rootDir = path.dirname(workspacePath);
const errors = [];
const workspace = JSON.parse(await readFile(workspacePath, "utf8"));
const gates = Array.isArray(workspace.gates) ? workspace.gates : [];
const gate = gates.find((candidate) => candidate && candidate.id === expectedGateId);

check(errors, workspace.version === 1, "/version", "unexpected_version", "Workspace version must be 1.");
check(
  errors,
  workspace.revision === expectedRevision,
  "/revision",
  "unexpected_revision",
  `Workspace revision must be ${expectedRevision}.`,
);
check(errors, gates.length === 1, "/gates", "unexpected_gate_count", "Demo result must contain exactly one gate.");
check(errors, Boolean(gate), "/gates", "missing_expected_gate", `Missing gate ${expectedGateId}.`);

if (gate) {
  check(errors, gate.type === "polygon", `/gates/${expectedGateId}/type`, "gate_not_polygon", "Demo gate must be polygon.");
  check(errors, gate.sample === expectedSample, `/gates/${expectedGateId}/sample`, "wrong_sample", `Gate sample must be ${expectedSample}.`);
  check(errors, gate.parent === "root", `/gates/${expectedGateId}/parent`, "wrong_parent", "Gate parent must be root.");
  check(errors, gate.x === expectedX, `/gates/${expectedGateId}/x`, "wrong_x_axis", `Gate x axis must be ${expectedX}.`);
  check(errors, gate.y === expectedY, `/gates/${expectedGateId}/y`, "wrong_y_axis", `Gate y axis must be ${expectedY}.`);
  check(
    errors,
    Array.isArray(gate.vertices) && gate.vertices.length >= 3,
    `/gates/${expectedGateId}/vertices`,
    "invalid_polygon_vertices",
    "Polygon gate must have at least three vertices.",
  );
}

for (const forbidden of ["scripts", "prompts"]) {
  check(
    errors,
    !(await exists(path.join(rootDir, forbidden))),
    `/${forbidden}`,
    "forbidden_demo_artifact",
    `Demo repo must not contain ${forbidden}/.`,
  );
}

if (allowNoAgents) {
  check(
    errors,
    !(await exists(path.join(rootDir, "AGENTS.md"))),
    "/AGENTS.md",
    "forbidden_demo_artifact",
    "No-AGENTS demo validation requires AGENTS.md to be absent.",
  );
}

process.stdout.write(JSON.stringify({
  ok: errors.length === 0,
  workspacePath,
  revision: workspace.revision,
  gateCount: gates.length,
  gateId: gate?.id,
  gateType: gate?.type,
  agentsAbsent: !(await exists(path.join(rootDir, "AGENTS.md"))),
  errors,
}, null, 2) + "\n");

process.exitCode = errors.length === 0 ? 0 : 1;
