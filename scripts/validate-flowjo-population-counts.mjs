import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { XMLParser } from "fast-xml-parser";

import { importFlowJoWorkspace, readWorkspace, getPopulationTable } from "../dist/src/core/index.js";

/**
 * Compares our computed population counts against the counts FlowJo recorded in
 * the .wsp itself.
 *
 * This is independent membership evidence, obtained without opening FlowJo: the
 * counts were written by FlowJo from the same FCS files. It tests gating
 * semantics, which screenshots cannot. It is NOT vendor-rendering equivalence.
 *
 * Usage: node scripts/validate-flowjo-population-counts.mjs <wsp> <fcs-dir> [tolerance]
 */
const [wspPath, fcsDirectory, toleranceArg] = process.argv.slice(2);
if (!wspPath || !fcsDirectory) {
  throw new Error("Usage: node scripts/validate-flowjo-population-counts.mjs <wsp> <fcs-directory> [tolerance]");
}
// Our previews subsample and boundary handling differs slightly, so exact
// equality is not expected; correct gates land within a couple of percent.
const tolerance = Number(toleranceArg ?? 0.02);

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
const table = await getPopulationTable({ workspacePath: imported.workspacePath, sampleIds });

/** Walks our gate tree in parent order, mirroring FlowJo's Subpopulations nesting. */
function ourChain(sampleId, parent, gates) {
  const children = workspace.gates.filter((gate) => gate.sample === sampleId && gate.parent === parent);
  return children.map((gate) => ({
    gate,
    count: gates[gate.id]?.count,
    children: ourChain(sampleId, gate.id, gates),
  }));
}

function flowjoChain(node) {
  return array(node?.Population).map((pop) => ({
    name: pop.name,
    count: Number(pop.count),
    children: flowjoChain(pop.Subpopulations),
  }));
}

const rows = [];
const walk = (theirs, ours, sampleId, prefix) => {
  theirs.forEach((they, index) => {
    const we = ours[index];
    const axes = we ? [we.gate.x, we.gate.y].filter(Boolean).join(" / ") : "";
    rows.push({
      sample: sampleId,
      population: `${prefix}/${they.name}`,
      axes,
      flowjo: they.count,
      ours: we?.count ?? null,
      ratio: we?.count != null && they.count ? we.count / they.count : null,
    });
    if (we) walk(they.children, we.children, sampleId, `${prefix}/${they.name}`);
  });
};

for (const sampleId of sampleIds) {
  const xmlSample = samplesByLocalId.get(sampleId);
  const gates = table.rows.find((row) => row.sampleId === sampleId)?.gates ?? {};
  walk(flowjoChain(xmlSample.SampleNode.Subpopulations), ourChain(sampleId, "root", gates), sampleId, "");
}

const compared = rows.filter((row) => row.ratio !== null);
const agreeing = compared.filter((row) => Math.abs(row.ratio - 1) <= tolerance);
const disagreeing = compared.filter((row) => Math.abs(row.ratio - 1) > tolerance);

// Group the disagreements by axis set, since a whole transform family failing
// together points at a coordinate-domain problem rather than one bad gate.
const byAxes = new Map();
for (const row of disagreeing) {
  const entry = byAxes.get(row.axes) ?? { axes: row.axes, populations: 0, worstRatio: 1 };
  entry.populations += 1;
  if (Math.abs(row.ratio - 1) > Math.abs(entry.worstRatio - 1)) entry.worstRatio = row.ratio;
  byAxes.set(row.axes, entry);
}

console.log(JSON.stringify({
  workspacePath: imported.workspacePath,
  tolerance,
  samples: sampleIds.length,
  comparedPopulations: compared.length,
  agreeing: agreeing.length,
  disagreeing: disagreeing.length,
  disagreementsByAxes: [...byAxes.values()].sort((a, b) => b.populations - a.populations),
  rows,
}, null, 2));

assert.ok(compared.length > 0, "No population counts could be compared; the probe must not pass vacuously.");
assert.equal(
  disagreeing.length,
  0,
  `${disagreeing.length} of ${compared.length} populations disagree with FlowJo's recorded counts beyond ${tolerance * 100}%:\n`
  + disagreeing.map((row) => `- ${row.population} [${row.axes}] FlowJo=${row.flowjo} ours=${row.ours} ratio=${row.ratio.toFixed(3)}`).join("\n"),
);
