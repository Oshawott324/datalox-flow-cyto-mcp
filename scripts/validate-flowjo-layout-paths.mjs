import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import { importFlowJoWorkspace, namePathToGateId, gateIdToNamePath } from "../dist/src/core/index.js";

// Reads source files only; each run imports into a new temporary workspace.
const [wspPath, fcsDirectory] = process.argv.slice(2);
if (!wspPath || !fcsDirectory) throw new Error("Usage: node scripts/validate-flowjo-layout-paths.mjs <wsp> <fcs-directory>");
const array = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
const xml = await fs.readFile(wspPath, "utf8");
const source = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", removeNSPrefix: true }).parse(xml).Workspace;
const samplePathMap = {};
const sampleIdMap = {};
const numericToLocal = new Map();
const groupReferencedSampleIds = new Set();
function collectGroupReferences(value) {
  if (!value || typeof value !== "object") return;
  for (const reference of array(value.SampleRef)) {
    if (reference?.sampleID !== undefined) groupReferencedSampleIds.add(String(reference.sampleID));
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "SampleRef") continue;
    if (Array.isArray(child)) child.forEach(collectGroupReferences);
    else collectGroupReferences(child);
  }
}
collectGroupReferences(source.Groups);
for (const sample of array(source.SampleList?.Sample)) {
  const name = sample.SampleNode.name;
  const numericId = String(sample.SampleNode.sampleID);
  const fileName = path.basename(decodeURIComponent(sample.DataSet.uri).replaceAll("\\", "/"));
  const file = path.resolve(fcsDirectory, fileName);
  await fs.access(file);
  samplePathMap[name] = file;
  sampleIdMap[name] = `flowjo_${numericId}`;
  assert(!numericToLocal.has(numericId), `Duplicate FlowJo sampleID ${numericId}`);
  numericToLocal.set(numericId, sampleIdMap[name]);
}
const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-layout-paths-"));
const imported = await importFlowJoWorkspace({ wspPath, workspaceDir, samplePathMap, sampleIdMap });
const workspace = JSON.parse(await fs.readFile(imported.workspacePath, "utf8"));
const layouts = [];
function visit(value) {
  if (!value || typeof value !== "object") return;
  if (value.Layout) layouts.push(...array(value.Layout));
  for (const [key, child] of Object.entries(value)) {
    if (key === "Layout") continue;
    if (Array.isArray(child)) child.forEach(visit);
    else visit(child);
  }
}
visit(source);
const results = [];
for (const layout of layouts) {
  for (const [panelIndex, panel] of array(layout.FigList?.ChartData).entries()) {
    for (const layer of array(panel.PopModelList?.DataLayer)) {
      const numericId = String(layer.sampleID);
      const sampleId = numericToLocal.get(numericId);
      const populationPath = layer.path ?? "";
      let resolution = sampleId
        ? namePathToGateId(workspace, sampleId, populationPath)
        : {
          status: "unknown_sample", flowjoSampleId: numericId,
          evidence: groupReferencedSampleIds.has(numericId) ? "group_reference_without_sample_node" : "layout_reference_without_sample_node",
          detail: groupReferencedSampleIds.has(numericId)
            ? `sampleID=${numericId} is referenced by a group (SampleRef) but has no SampleNode; the sample definition is absent from this workspace.`
            : `sampleID=${numericId} has no SampleNode or group SampleRef; the layout reference cannot be bound.`,
        };
      if (resolution.status === "resolved") {
        const encoding = gateIdToNamePath(workspace, sampleId, resolution.gateId);
        if (encoding.status !== "ok" || encoding.path !== populationPath) {
          resolution = {
            status: "round_trip_mismatch", gateId: resolution.gateId,
            expectedPath: populationPath, encoding,
          };
        }
      }
      results.push({ layout: layout.name, panelIndex, numericId, sampleId, path: populationPath, resolution });
    }
  }
}
assert(results.length > 0, "No layout DataLayers found; probe must not pass vacuously");
console.log(JSON.stringify({ workspacePath: imported.workspacePath, layouts: layouts.length,
  importedSamples: imported.samplesImported, importedGates: imported.gatesImported,
  importWarnings: imported.warnings, checked: results.length,
  resolved: results.filter((entry) => entry.resolution.status === "resolved").length, results }, null, 2));
if (results.some((entry) => entry.resolution.status !== "resolved")) process.exitCode = 1;
