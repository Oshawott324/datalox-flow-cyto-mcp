import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { XMLParser } from "fast-xml-parser";

import { importFlowJoWorkspace, readWorkspace, getPopulationGraph, namePathToGateId } from "../dist/src/core/index.js";

/**
 * Compares our computed population counts against the counts FlowJo recorded in
 * the .wsp itself.
 *
 * This is aggregate-count evidence, not event-membership ground truth. Equal
 * counts do not prove identical selected events, and stored counts may be stale.
 * It is NOT vendor-rendering equivalence.
 *
 * Usage: node scripts/validate-flowjo-population-counts.mjs <wsp> <fcs-dir> [tolerance]
 */
const [wspPath, fcsDirectory, toleranceArg] = process.argv.slice(2);
if (!wspPath || !fcsDirectory) {
  throw new Error("Usage: node scripts/validate-flowjo-population-counts.mjs <wsp> <fcs-directory> [tolerance]");
}
// Population graphs count all events. This is an explicit diagnostic tolerance,
// not an allowance for preview subsampling or a scientific acceptance guarantee.
const tolerance = Number(toleranceArg ?? 0.02);
assert(Number.isFinite(tolerance) && tolerance >= 0 && tolerance < 1, "tolerance must be in [0,1)");

const array = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);
const xml = await fs.readFile(wspPath, "utf8");
const source = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", removeNSPrefix: true })
  .parse(xml).Workspace;

const samplePathMap = {};
const sampleIdMap = {};
const samplesByLocalId = new Map();
for (const sample of array(source.SampleList?.Sample)) {
  const name = sample.SampleNode.name;
  const file = path.resolve(fcsDirectory, path.basename(decodeURIComponent(sample.DataSet.uri).replaceAll("\\", "/")));
  await fs.access(file);
  samplePathMap[name] = file;
  const localId = `flowjo_${sample.SampleNode.sampleID}`;
  sampleIdMap[name] = localId;
  samplesByLocalId.set(localId, sample);
}

const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-counts-"));
const imported = await importFlowJoWorkspace({ wspPath, workspaceDir, samplePathMap, sampleIdMap });
const workspace = await readWorkspace(imported.workspacePath);
const sampleIds = [...samplesByLocalId.keys()].filter((id) =>
  workspace.samples.some((sample) => sample.id === id));
const graphs = new Map();
const sampleReports = [];
for (const sampleId of sampleIds) {
  const matrices = (workspace.compensations ?? []).filter((matrix) => matrix.sample === sampleId && matrix.source === "flowjo_wsp");
  const declared = array(samplesByLocalId.get(sampleId).spilloverMatrix);
  assert.equal(matrices.length, declared.length, `Not all declared matrices imported for ${sampleId}`);
  assert(matrices.length <= 1, `Multiple matrices for ${sampleId}; explicit per-population binding is required`);
  const graph = await getPopulationGraph({ workspacePath: imported.workspacePath, sampleId, compensationId: matrices[0]?.id });
  const nodes = new Map();
  function collect(node) { nodes.set(node.gateId, node); node.children.forEach(collect); }
  collect(graph.root);
  graphs.set(sampleId, nodes);
  sampleReports.push({ sampleId, compensationId: matrices[0]?.id ?? null, originalEventCount: graph.root.count,
    flowjoRootCount: Number(samplesByLocalId.get(sampleId).SampleNode.count) });
}

/** Retains XML ancestry so imported populations can be matched by sample and path. */
function flowjoChain(node) {
  return array(node?.Population).map((pop) => ({
    name: pop.name,
    count: Number(pop.count),
    children: flowjoChain(pop.Subpopulations),
  }));
}

const rows = [];
const walk = (theirs, sampleId, prefix) => {
  theirs.forEach((they) => {
    const population = prefix ? `${prefix}/${they.name}` : they.name;
    const resolution = namePathToGateId(workspace, sampleId, population);
    const we = resolution.status === "resolved" ? graphs.get(sampleId).get(resolution.gateId) : undefined;
    const gate = workspace.gates.find((entry) => entry.sample === sampleId && entry.id === we?.gateId);
    const axes = gate ? [gate.x, gate.y].filter(Boolean).join(" / ") : "";
    const validReference = Number.isInteger(they.count) && they.count >= 0;
    const relativeError = validReference && we ? Math.abs(we.count - they.count) / Math.max(1, they.count) : null;
    rows.push({
      sample: sampleId,
      population,
      resolution,
      axes,
      flowjo: they.count,
      ours: we?.count ?? null,
      ratio: we?.count != null && they.count ? we.count / they.count : null,
      relativeError,
      status: relativeError === null ? "uncompared" : relativeError <= tolerance ? "agreeing" : "disagreeing",
    });
    walk(they.children, sampleId, population);
  });
};

for (const sampleId of sampleIds) {
  const xmlSample = samplesByLocalId.get(sampleId);
  walk(flowjoChain(xmlSample.SampleNode.Subpopulations), sampleId, "");
}

const compared = rows.filter((row) => row.status !== "uncompared");
const agreeing = rows.filter((row) => row.status === "agreeing");
const disagreeing = rows.filter((row) => row.status === "disagreeing");
const uncompared = rows.filter((row) => row.status === "uncompared");

// Group the disagreements by axis set, since a whole transform family failing
// together points at a coordinate-domain problem rather than one bad gate.
const byAxes = new Map();
for (const row of disagreeing) {
  const entry = byAxes.get(row.axes) ?? { axes: row.axes, populations: 0, worstRelativeError: 0 };
  entry.populations += 1;
  entry.worstRelativeError = Math.max(entry.worstRelativeError, row.relativeError);
  byAxes.set(row.axes, entry);
}

console.log(JSON.stringify({
  workspacePath: imported.workspacePath,
  tolerance,
  samples: sampleIds.length,
  sampleReports,
  uncompared: uncompared.length,
  comparedPopulations: compared.length,
  agreeing: agreeing.length,
  disagreeing: disagreeing.length,
  disagreementsByAxes: [...byAxes.values()].sort((a, b) => b.populations - a.populations),
  rows,
}, null, 2));

assert.ok(compared.length > 0, "No population counts could be compared; the probe must not pass vacuously.");
assert.equal(uncompared.length, 0, "Some reference populations could not be compared.");
assert.equal(
  disagreeing.length,
  0,
  `${disagreeing.length} of ${compared.length} populations disagree with FlowJo's recorded counts beyond ${tolerance * 100}%:\n`
  + disagreeing.map((row) => `- ${row.population} [${row.axes}] FlowJo=${row.flowjo} ours=${row.ours} relativeError=${row.relativeError}`).join("\n"),
);
