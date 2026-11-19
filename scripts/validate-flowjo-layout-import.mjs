import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { XMLParser } from "fast-xml-parser";

import { importFlowJoWorkspace } from "../dist/src/core/index.js";

// Imports a real FlowJo .wsp into a fresh temporary workspace and checks the L4
// acceptance criteria. The source .wsp and FCS files are hashed before and after
// to prove the import leaves them untouched.
const [wspPath, fcsDirectory] = process.argv.slice(2);
if (!wspPath || !fcsDirectory) {
  throw new Error("Usage: node scripts/validate-flowjo-layout-import.mjs <wsp> <fcs-directory>");
}

const array = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);
const normalize = (value) => String(value ?? "").toLowerCase().replace(/[\s_-]+/g, "");
const failures = [];
const check = (label, condition, detail) => {
  if (!condition) failures.push(detail ? `${label}: ${detail}` : label);
  return condition;
};

async function hashFile(file) {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

const xml = await fs.readFile(wspPath, "utf8");
const source = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", removeNSPrefix: true })
  .parse(xml).Workspace;

// --- source file fingerprints before import -------------------------------
const fcsFiles = (await fs.readdir(fcsDirectory))
  .filter((name) => name.toLowerCase().endsWith(".fcs"))
  .map((name) => path.join(fcsDirectory, name));
const before = new Map();
before.set(wspPath, await hashFile(wspPath));
for (const file of fcsFiles) before.set(file, await hashFile(file));

// --- sample maps ----------------------------------------------------------
const samplePathMap = {};
const sampleIdMap = {};
const numericToLocal = new Map();
for (const sample of array(source.SampleList?.Sample)) {
  const name = sample.SampleNode.name;
  const numericId = String(sample.SampleNode.sampleID);
  const fileName = path.basename(decodeURIComponent(sample.DataSet.uri).replaceAll("\\", "/"));
  const file = path.resolve(fcsDirectory, fileName);
  await fs.access(file);
  samplePathMap[name] = file;
  sampleIdMap[name] = `flowjo_${numericId}`;
  numericToLocal.set(numericId, sampleIdMap[name]);
}

// --- import ---------------------------------------------------------------
const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-layout-import-"));
const result = await importFlowJoWorkspace({ wspPath, workspaceDir, samplePathMap, sampleIdMap });
const workspace = JSON.parse(await fs.readFile(result.workspacePath, "utf8"));
const layouts = workspace.layouts ?? [];
const panels = layouts.flatMap((layout) => layout.panels);
const resolved = panels.filter((panel) => panel.status.state === "resolved");
const unresolved = panels.filter((panel) => panel.status.state === "unresolved");

// --- criterion 1: preserve 2 layouts and all 11 panels --------------------
check("2 layouts preserved", layouts.length === 2, `got ${layouts.length}`);
check("11 panels preserved", panels.length === 11, `got ${panels.length}`);
check("gating strategy layout classified", layouts[0]?.kind === "gating_strategy", layouts[0]?.kind);
check("comparison layout classified", layouts[1]?.kind === "comparison", layouts[1]?.kind);

// --- criterion 2: 9 resolved, 2 unresolved with SampleRef evidence --------
check("9 panels resolved", resolved.length === 9, `got ${resolved.length}`);
check("2 panels unresolved", unresolved.length === 2, `got ${unresolved.length}`);
for (const id of ["2", "20"]) {
  const panel = unresolved.find((entry) => entry.status.detail.includes(`sampleID=${id}`));
  if (!check(`sampleID=${id} retained as a labelled panel`, Boolean(panel))) continue;
  check(`sampleID=${id} reason is unknown_sample`, panel.status.reason === "unknown_sample", panel.status.reason);
  check(`sampleID=${id} carries SampleRef evidence`, panel.status.detail.includes("SampleRef"), panel.status.detail);
  check(`sampleID=${id} panel carries no invented source`, panel.sources.length === 0, `${panel.sources.length} sources`);
  check(`sampleID=${id} original reference preserved`, Boolean(panel._flowjo?.PopModelList));
}

// --- criterion 3: axes verified against XML and sample metadata -----------
const metadataByLocalId = new Map(
  workspace.samples.map((sample) => [sample.id, null]),
);
const { getSampleMetadata } = await import("../dist/src/core/index.js");
for (const sample of workspace.samples) {
  metadataByLocalId.set(sample.id, await getSampleMetadata(result.workspacePath, sample.id));
}

const xmlAxisByPanel = new Map();
const collectLayoutNodes = (value, found = []) => {
  if (!value || typeof value !== "object") return found;
  for (const layout of array(value.Layout)) found.push(layout);
  for (const [key, child] of Object.entries(value)) {
    if (key === "Layout") continue;
    if (Array.isArray(child)) child.forEach((entry) => collectLayoutNodes(entry, found));
    else collectLayoutNodes(child, found);
  }
  return found;
};
collectLayoutNodes(source).forEach((layoutNode, layoutIndex) => {
  array(layoutNode.FigList?.ChartData).forEach((chart, chartIndex) => {
    const axes = array(chart.Graph?.Axis);
    xmlAxisByPanel.set(`${layoutIndex}:${chartIndex}`, {
      x: axes.find((axis) => axis.dimension === "x")?.name,
      y: axes.find((axis) => axis.dimension === "y")?.name,
    });
  });
});

let axesChecked = 0;
layouts.forEach((layout, layoutIndex) => {
  layout.panels.forEach((panel, panelIndex) => {
    if (panel.status.state !== "resolved") return;
    const fromXml = xmlAxisByPanel.get(`${layoutIndex}:${panelIndex}`);
    check(`panel ${panel.id} has a matching XML ChartData`, Boolean(fromXml));
    if (!fromXml) return;
    for (const [dimension, axis] of [["x", panel.x], ["y", panel.y]]) {
      if (!axis) continue;
      const xmlName = fromXml[dimension];
      check(`panel ${panel.id} ${dimension} axis exists in XML`, Boolean(xmlName));
      if (!xmlName) continue;
      const bare = xmlName.replace(/^(FJComp-|Comp-|C_)/i, "");
      for (const source of panel.sources) {
        const metadata = metadataByLocalId.get(source.sample);
        // The XML name may be a detector ($PnN) or marker ($PnS) alias, so trace it
        // through this sample's parameters rather than comparing strings. This is
        // the point of criterion 3: XML definition AND parameter metadata.
        const expected = metadata?.parameters.find((parameter) =>
          [parameter.name, parameter.detector, parameter.marker]
            .filter(Boolean)
            .some((alias) => normalize(alias) === normalize(bare)));
        check(
          `panel ${panel.id} ${dimension} axis traces XML name ${xmlName} to a parameter of ${source.sample}`,
          Boolean(expected),
          `no parameter matches ${bare}`,
        );
        if (!expected) continue;
        check(
          `panel ${panel.id} ${dimension} axis stores the resolved parameter name`,
          axis.channel === expected.name,
          `stored ${axis.channel}, expected ${expected.name} (from XML ${xmlName})`,
        );
      }
      axesChecked += 1;
    }
  });
});
check("axes were actually checked", axesChecked > 0, `${axesChecked}`);

// --- criterion 4: compensation from explicit references only --------------
const compensatedSources = resolved.flatMap((panel) => panel.sources.filter((s) => s.unresolvedCompensation));
check(
  "compensated axes produced explicit unresolved references",
  compensatedSources.length > 0,
  "no source recorded an unresolved compensation reference",
);
for (const source of compensatedSources) {
  check(
    "unresolved compensation names the FlowJo matrix",
    /matrix "/.test(source.unresolvedCompensation.detail),
    source.unresolvedCompensation.detail,
  );
  check(
    "unresolved compensation never claims uncompensated",
    !/uncompensated/i.test(source.unresolvedCompensation.detail),
    source.unresolvedCompensation.detail,
  );
}
check(
  "no source silently carries a bound compensationId",
  resolved.every((panel) => panel.sources.every((s) => s.compensationId === undefined)),
  "a compensationId was invented without an imported matrix",
);

// --- criterion 5: _flowjo preserved, live references win ------------------
for (const panel of resolved) {
  check(`panel ${panel.id} preserved ChartData attrs`, Boolean(panel._flowjo?.ChartData));
  const preservedLayers = array(panel._flowjo?.PopModelList?.DataLayer);
  for (const layer of preservedLayers) {
    const local = numericToLocal.get(String(layer.sampleID));
    check(
      `panel ${panel.id} live sample reference matches the preserved sampleID`,
      panel.sources.some((source) => source.sample === local),
      `preserved sampleID=${layer.sampleID} -> ${local}; live: ${panel.sources.map((s) => s.sample).join(", ")}`,
    );
  }
  check(
    `panel ${panel.id} stores live gate ids, not FlowJo name paths`,
    panel.sources.every((source) => source.parent === "root" || !source.parent.includes("/")),
    panel.sources.map((s) => s.parent).join(", "),
  );
}

// --- criterion 6: source files unchanged ----------------------------------
for (const [file, hash] of before) {
  check(`source file unchanged: ${path.basename(file)}`, (await hashFile(file)) === hash);
}

// --- dry run writes nothing ----------------------------------------------
const dryDir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-layout-dryrun-"));
const dry = await importFlowJoWorkspace({ wspPath, workspaceDir: dryDir, samplePathMap, sampleIdMap, dryRun: true });
check("dry run reports dryRun", dry.dryRun === true);
check("dry run resolves the same panels", dry.layoutPanels.resolved === 9, `${dry.layoutPanels.resolved}`);
check(
  "dry run writes no workspace artifact",
  !(await fs.access(dry.workspacePath).then(() => true, () => false)),
);

console.log(JSON.stringify({
  workspacePath: result.workspacePath,
  layouts: layouts.map((layout) => ({
    id: layout.id, name: layout.name, kind: layout.kind, canvas: layout.canvas, panels: layout.panels.length,
  })),
  layoutsImported: result.layoutsImported,
  layoutPanels: result.layoutPanels,
  layoutCompensationReferences: result.layoutCompensationReferences,
  axesChecked,
  unresolved: unresolved.map((panel) => ({ id: panel.id, reason: panel.status.reason, detail: panel.status.detail })),
  failures,
}, null, 2));

assert.equal(failures.length, 0, `${failures.length} acceptance checks failed:\n- ${failures.join("\n- ")}`);
