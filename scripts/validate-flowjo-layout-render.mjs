import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { XMLParser } from "fast-xml-parser";

import { importFlowJoWorkspace, readWorkspace } from "../dist/src/core/index.js";
import { renderLayout } from "../dist/src/app/gate-editor/layout-image.js";
import { renderPlotSvg } from "../dist/src/app/gate-editor/plot-image.js";
import { getRenderablePlotContext } from "../dist/src/app/gate-editor/server.js";

// Renders the layouts of a real FlowJo .wsp and checks each panel against a
// standalone render built from the same inputs.
const [wspPath, fcsDirectory] = process.argv.slice(2);
if (!wspPath || !fcsDirectory) {
  throw new Error("Usage: node scripts/validate-flowjo-layout-render.mjs <wsp> <fcs-directory>");
}

const array = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);
const failures = [];
const check = (label, condition, detail) => {
  if (!condition) failures.push(detail ? `${label}: ${detail}` : label);
  return condition;
};

const xml = await fs.readFile(wspPath, "utf8");
const source = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", removeNSPrefix: true })
  .parse(xml).Workspace;

const samplePathMap = {};
const sampleIdMap = {};
for (const sample of array(source.SampleList?.Sample)) {
  const name = sample.SampleNode.name;
  const file = path.resolve(fcsDirectory, path.basename(decodeURIComponent(sample.DataSet.uri).replaceAll("\\", "/")));
  await fs.access(file);
  samplePathMap[name] = file;
  sampleIdMap[name] = `flowjo_${sample.SampleNode.sampleID}`;
}

const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-layout-render-"));
const imported = await importFlowJoWorkspace({ wspPath, workspaceDir, samplePathMap, sampleIdMap });
const workspace = await readWorkspace(imported.workspacePath);
const layouts = workspace.layouts ?? [];
check("two layouts imported", layouts.length === 2, `${layouts.length}`);

const report = [];
for (const layout of layouts) {
  const rendered = await renderLayout({
    workspacePath: imported.workspacePath,
    layoutId: layout.id,
    maxEvents: 20000,
  });

  check(`${layout.name}: compensation mode is explicit`, rendered.compensationMode === "as_recorded");
  check(`${layout.name}: every panel is accounted for`,
    rendered.panels.length === layout.panels.length,
    `${rendered.panels.length} vs ${layout.panels.length}`);

  // No panel that failed to bind may be drawn.
  for (const panel of layout.panels) {
    const result = rendered.panels.find((entry) => entry.id === panel.id);
    if (panel.status.state !== "resolved") {
      check(`${layout.name}: ${panel.id} is a placeholder`, result?.state === "placeholder", result?.state);
      check(`${layout.name}: ${panel.id} placeholder states a reason`, Boolean(result?.reason));
      check(`${layout.name}: ${panel.id} placeholder carries no source report`, result?.sources === undefined);
    }
  }

  // Each rendered panel must match a standalone render of the same inputs, and
  // must report the compensation that was actually applied.
  for (const result of rendered.panels.filter((entry) => entry.state === "rendered")) {
    const panel = layout.panels.find((entry) => entry.id === result.id);
    const panelSource = panel.sources[0];
    const context = await getRenderablePlotContext({
      workspacePath: imported.workspacePath,
      sampleId: panelSource.sample,
      parent: panelSource.parent,
      x: panel.x.channel,
      y: panel.y?.channel,
      maxEvents: 20000,
      compensationId: panelSource.compensationId,
    });
    const standalone = renderPlotSvg(context, panel.position.width, panel.position.height);
    const inner = standalone.slice(standalone.indexOf(">") + 1);
    check(
      `${layout.name}: ${result.id} matches a standalone render of the same inputs`,
      rendered.image.svg.includes(inner),
      `panel ${panel.x.channel} vs ${panel.y?.channel} for ${panelSource.sample}`,
    );

    // Counts come from the same preview pipeline a single plot would use.
    check(
      `${layout.name}: ${result.id} reports the same event counts as the standalone render`,
      result.previewSummary.sampledEvents === context.previewSummary.sampledEvents
        && result.previewSummary.filteredEvents === context.previewSummary.filteredEvents,
      `${result.previewSummary.sampledEvents}/${result.previewSummary.filteredEvents} vs ${context.previewSummary.sampledEvents}/${context.previewSummary.filteredEvents}`,
    );
    check(
      `${layout.name}: ${result.id} draws the same gate overlays`,
      result.gateCount === context.gates.length,
      `${result.gateCount} vs ${context.gates.length}`,
    );

    const applied = result.sources[0].applied;
    if (panelSource.compensationId) {
      check(`${layout.name}: ${result.id} applied its recorded compensation`,
        applied.applied === true && applied.id === panelSource.compensationId,
        `${applied.applied} ${applied.id}`);
      check(`${layout.name}: ${result.id} used its own sample's matrix`,
        String(applied.id).includes(panelSource.sample),
        `${applied.id} for ${panelSource.sample}`);
    } else {
      check(`${layout.name}: ${result.id} reports no compensation applied`, applied.applied === false);
    }

    // A biex axis must carry the parameters the import read from this sample.
    if (panel.x.scale === "biex") {
      check(`${layout.name}: ${result.id} x axis kept biex parameters`,
        Number.isFinite(panel.x.transform?.width) && Number.isFinite(panel.x.transform?.pos),
        JSON.stringify(panel.x.transform));
    }
  }

  // compensation="none" must differ from the recorded render wherever a matrix
  // was applied, and must say so rather than quietly producing the same bytes.
  const raw = await renderLayout({
    workspacePath: imported.workspacePath,
    layoutId: layout.id,
    compensation: "none",
    maxEvents: 20000,
    output: "content",
  });
  const compensatedPanels = rendered.panels.filter((entry) => entry.sources?.[0]?.applied?.applied);
  if (compensatedPanels.length > 0) {
    check(`${layout.name}: compensation="none" changes the render`,
      raw.image.svg !== rendered.image.svg);
    check(`${layout.name}: compensation="none" reports nothing applied`,
      raw.panels.every((entry) => !entry.sources || entry.sources[0].applied.applied === false));
    check(`${layout.name}: compensation="none" still records the configuration`,
      raw.panels.some((entry) => entry.sources?.[0]?.recordedCompensationId));
  }

  report.push({
    layout: layout.name,
    kind: rendered.kind,
    canvas: rendered.canvas,
    rendered: rendered.rendered,
    placeholders: rendered.placeholders,
    svgPath: rendered.image.path,
    placeholderReasons: rendered.panels
      .filter((entry) => entry.state === "placeholder")
      .map((entry) => ({ id: entry.id, reason: entry.reason.slice(0, 120) })),
  });
}

const strategy = report.find((entry) => entry.kind === "gating_strategy");
const comparison = report.find((entry) => entry.kind === "comparison");
check("strategy layout renders all six panels", strategy?.rendered === 6 && strategy?.placeholders === 0,
  `${strategy?.rendered}/${strategy?.placeholders}`);
check("comparison layout renders three plots and two placeholders",
  comparison?.rendered === 3 && comparison?.placeholders === 2,
  `${comparison?.rendered}/${comparison?.placeholders}`);

console.log(JSON.stringify({ workspacePath: imported.workspacePath, report, failures }, null, 2));
assert.equal(failures.length, 0, `${failures.length} render checks failed:\n- ${failures.join("\n- ")}`);
