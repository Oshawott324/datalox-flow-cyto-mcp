import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { XMLParser } from "fast-xml-parser";

import { importFlowJoWorkspace, readWorkspace } from "../dist/src/core/index.js";
import { renderLayout } from "../dist/src/app/gate-editor/layout-image.js";
import { renderPlotSvg } from "../dist/src/app/gate-editor/plot-image.js";
import { configurePlotAxes } from "../dist/src/app/gate-editor/plot-axis-context.js";
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
    const configured = configurePlotAxes(context, { x: panel.x, y: panel.y });
    const standalone = renderPlotSvg(configured, panel.position.width, panel.position.height, `layout_clip_${layout.panels.indexOf(panel)}`);
    check(`${layout.name}: ${result.id} reports requested scale`,
      result.scale.x === (panel.x.scale ?? context.scale.x) && result.scale.y === (panel.y.scale ?? context.scale.y));
    check(`${layout.name}: ${result.id} reports requested transform parameters`,
      JSON.stringify(result.axisConfiguration.x.transform) === JSON.stringify(panel.x.transform)
      && JSON.stringify(result.axisConfiguration.y.transform) === JSON.stringify(panel.y.transform));
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
    check(`${layout.name}: compensation="none" blocks coordinate-space mismatches`,
      compensatedPanels.every((panel) => raw.panels.find((entry) => entry.id === panel.id)?.reason?.includes("compensation_space_mismatch")));
  }

  // Every id in the composited SVG must be unique and every url(#..) must
  // resolve: panels are nested SVGs, so a shared clipPath id would silently
  // make one panel clip against another's rectangle.
  const ids = [...rendered.image.svg.matchAll(/\sid="([^"]*)"/g)].map((match) => match[1]);
  const refs = [...rendered.image.svg.matchAll(/url\(#([^)]*)\)/g)].map((match) => match[1]);
  check(`${layout.name}: SVG ids are unique`, new Set(ids).size === ids.length,
    `${ids.length} ids, ${new Set(ids).size} unique`);
  check(`${layout.name}: every url(#..) reference resolves`,
    refs.every((ref) => ids.includes(ref)), refs.filter((ref) => !ids.includes(ref)).join(", "));

  // The page box is reported separately from the expanded review viewport, so
  // exporting the layout cannot inherit the grown canvas.
  check(`${layout.name}: page geometry is preserved separately`,
    rendered.pageCanvas.width === layout.canvas.width && rendered.pageCanvas.height === layout.canvas.height,
    `${JSON.stringify(rendered.pageCanvas)} vs ${JSON.stringify(layout.canvas)}`);
  check(`${layout.name}: viewport covers every panel`,
    layout.panels.every((panel) =>
      panel.position.x >= rendered.viewport.x && panel.position.y >= rendered.viewport.y
      && panel.position.x + panel.position.width <= rendered.viewport.x + rendered.viewport.width
      && panel.position.y + panel.position.height <= rendered.viewport.y + rendered.viewport.height));

  const blockedByTransform = rendered.panels.filter((entry) =>
    entry.reason?.includes("layout_axis_configuration_not_supported"));

  report.push({
    layout: layout.name,
    kind: rendered.kind,
    pageCanvas: rendered.pageCanvas,
    viewport: rendered.viewport,
    rendered: rendered.rendered,
    placeholders: rendered.placeholders,
    blockedByTransform: blockedByTransform.length,
    svgPath: rendered.image.path,
    placeholderReasons: rendered.panels
      .filter((entry) => entry.state === "placeholder")
      .map((entry) => ({ id: entry.id, reason: entry.reason.slice(0, 120) })),
  });
}

const strategy = report.find((entry) => entry.kind === "gating_strategy");
const comparison = report.find((entry) => entry.kind === "comparison");

// Pipeline acceptance is separate from independent vendor equivalence.
check("strategy layout renders all six panels",
  strategy?.rendered === 6 && strategy?.placeholders === 0,
  `rendered ${strategy?.rendered}, blocked ${strategy?.blockedByTransform}`);
check("comparison layout renders three panels and preserves both dangling samples",
  comparison?.rendered === 3 && comparison?.blockedByTransform === 0 && comparison?.placeholders === 2,
  `rendered ${comparison?.rendered}, blocked ${comparison?.blockedByTransform}, placeholders ${comparison?.placeholders}`);

// Every axis carrying FlowJo transform parameters must also state the input
// domain those parameters are in, and it must be the bound cytometer's factor.
// Without it the data sits far above its own maxRange and the population is
// compressed into a corner of the plot, which is how this defect presented.
const cytometers = (Array.isArray(source.Cytometers?.Cytometer)
  ? source.Cytometers.Cytometer
  : [source.Cytometers?.Cytometer]).filter(Boolean);
const declaredDivisors = new Set(cytometers.map((entry) => Number(entry.logRescale)).filter((value) => Number.isFinite(value) && value > 0));

const rescaledAxes = [];
for (const layout of layouts) {
  for (const panel of layout.panels) {
    if (panel.status.state !== "resolved") continue;
    for (const key of ["x", "y"]) {
      const axis = panel[key];
      if (!axis?.transform || !Number.isFinite(axis.transform.maxRange)) continue;
      rescaledAxes.push({ panel: panel.id, axis: key, channel: axis.channel, maxRange: axis.transform.maxRange, inputDivisor: axis.inputDivisor });
      check(`${layout.name}: ${panel.id} ${key} axis states its input domain`,
        Number.isFinite(axis.inputDivisor) && axis.inputDivisor > 0,
        `inputDivisor=${axis.inputDivisor} for ${axis.channel}`);
      check(`${layout.name}: ${panel.id} ${key} axis divisor comes from a declared cytometer`,
        declaredDivisors.has(axis.inputDivisor),
        `${axis.inputDivisor} not in ${[...declaredDivisors].join(", ")}`);
    }
  }
}
check("some axis carries an imported transform, so the divisor checks are not vacuous", rescaledAxes.length > 0);

const knownGaps = [
  {
    id: "flowjo_equivalence_unverified",
    detail: "No panel has been compared against FlowJo's own rendering. Current evidence is pipeline consistency plus agreement with FlowJo's own recorded population counts (scripts/validate-flowjo-population-counts.mjs), not vendor rendering equivalence.",
  },
  {
    id: "axis_tick_units_are_fcs_units",
    detail: "Tick labels are in FCS data units, not the rescaled units FlowJo prints on its own axes. A side-by-side screenshot comparison will show different axis numbers for the same positions by design; see docs/layout-plan-2026-11-17.md.",
    axes: rescaledAxes,
  },
];

console.log(JSON.stringify({ workspacePath: imported.workspacePath, report, knownGaps, failures }, null, 2));
assert.equal(failures.length, 0, `${failures.length} render checks failed:\n- ${failures.join("\n- ")}`);
