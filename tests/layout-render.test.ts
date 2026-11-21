import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { renderLayout } from "../src/app/gate-editor/layout-image.js";
import { renderPlotSvg } from "../src/app/gate-editor/plot-image.js";
import { configurePlotAxes, buildPanelAxisMapping } from "../src/app/gate-editor/plot-axis-context.js";
import { getRenderablePlotContext } from "../src/app/gate-editor/server.js";
import {
  importFlowJoWorkspace,
  readWorkspace,
  upsertLayout,
  suggestComparisonLayout,
  suggestGatingStrategyLayout,
  type FlowcytoLayout,
} from "../src/core/index.js";

const fixtureWsp = path.join(process.cwd(), "testdata", "fixtures", "flowjo", "layouts.wsp");

async function writeFcs(fcsPath: string): Promise<void> {
  const channels = ["FSC-A", "SSC-A", "FITC-A", "PE-A"];
  const markers: Array<string | undefined> = [undefined, undefined, "FL03-A", "FL13-A"];
  const rows = Array.from({ length: 24 }, (_, index) => [
    100 + index * 7, 200 + index * 5, 300 + index * 3, 400 + index * 2,
  ]);
  const data = Buffer.alloc(rows.length * channels.length * 2);
  let cursor = 0;
  for (const row of rows) {
    for (const value of row) {
      data.writeUInt16LE(value, cursor);
      cursor += 2;
    }
  }
  const textSegment = (beginData: number, endData: number) => {
    const entries = [
      "$BEGINANALYSIS", "0", "$BEGINDATA", String(beginData).padStart(12, "0"),
      "$BYTEORD", "1,2,3,4", "$DATATYPE", "I", "$ENDANALYSIS", "0",
      "$ENDDATA", String(endData).padStart(12, "0"), "$MODE", "L", "$NEXTDATA", "0",
      "$PAR", String(channels.length), "$TOT", String(rows.length),
    ];
    channels.forEach((channel, index) => {
      const number = index + 1;
      entries.push(`$P${number}B`, "16", `$P${number}N`, channel, `$P${number}R`, "65535");
      const marker = markers[index];
      if (marker) entries.push(`$P${number}S`, marker);
    });
    return `|${entries.join("|")}|`;
  };
  const textStart = 58;
  const dataStart = textStart + textSegment(0, 0).length;
  const dataEnd = dataStart + data.length - 1;
  const text = textSegment(dataStart, dataEnd);
  const header = `FCS3.1    ${String(textStart).padStart(8)}${String(textStart + text.length - 1).padStart(8)}`
    + `${String(dataStart).padStart(8)}${String(dataEnd).padStart(8)}${String(0).padStart(8)}${String(0).padStart(8)}`;
  await fs.writeFile(fcsPath, Buffer.concat([Buffer.from(header, "ascii"), Buffer.from(text, "latin1"), data]));
}

let workspacePath = "";
let layouts: FlowcytoLayout[] = [];
let supported: FlowcytoLayout[] = [];

beforeAll(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-layout-render-"));
  const alpha = path.join(dir, "alpha.fcs");
  const beta = path.join(dir, "beta.fcs");
  await writeFcs(alpha);
  await writeFcs(beta);
  const result = await importFlowJoWorkspace({
    wspPath: fixtureWsp,
    workspaceDir: dir,
    samplePathMap: { "alpha.fcs": alpha, "beta.fcs": beta },
    sampleIdMap: { "alpha.fcs": "alpha", "beta.fcs": "beta" },
  });
  workspacePath = result.workspacePath;
  layouts = (await readWorkspace(workspacePath)).layouts ?? [];
  // Separate native-layout fixtures use preview-default axes. Imported transform
  // configurations remain untouched and are tested as unsupported below.
  supported = layouts.map((layout) => ({ ...layout, id: `${layout.id}_native`, source: "manual" as const,
    panels: layout.panels.map((panel) => ({ ...panel,
      x: { channel: panel.x.channel }, y: panel.y ? { channel: panel.y.channel } : undefined,
    })),
  }));
  for (const layout of supported) {
    const result = await upsertLayout({ workspacePath, layout, expectedRevision: (await readWorkspace(workspacePath)).revision });
    expect(result.ok).toBe(true);
  }
});

const strategy = () => supported[0];
const comparison = () => supported[1];

describe("layout rendering", () => {
  it("maps points and overlays numerically with log/arcsinh parameters and fixed bounds", async () => {
    const context = await getRenderablePlotContext({ workspacePath, sampleId: "alpha", parent: "root", x: "FITC-A", y: "PE-A", format: "points" });
    context.preview = { ...context.preview, bins: undefined, points: [[10, 0]], format: "points" };
    context.gates = [{ id: "check", sample: "alpha", parent: "root", type: "polygon", x: "FITC-A", y: "PE-A", vertices: [[10, 0], [100, 0], [10, 10]] }];
    const configured = configurePlotAxes(context, {
      x: { channel: "FITC-A", scale: "log", bounds: { min: 1, max: 100 } },
      y: { channel: "PE-A", scale: "arcsinh", transform: { cofactor: 10 }, bounds: { min: -10, max: 10 } },
    });
    expect(configured.visualBounds.xMin).toBe(0);
    expect(configured.visualBounds.xMax).toBe(2);
    expect(configured.visualBounds.yMin).toBeCloseTo(-Math.asinh(1), 12);
    expect(configured.axisMapping!.y.inverse(Math.asinh(1))).toBeCloseTo(10, 12);
    const svg = renderPlotSvg(configured, 760, 560);
    // x=10 is halfway on log10[1,100], y=0 halfway on symmetric arcsinh.
    expect(svg).toContain('cx="402" cy="276"');
    expect(svg).toContain('points="402,276');
    expect(() => configurePlotAxes(context, { x: { channel: "FITC-A", scale: "log", bounds: { min: 0, max: 100 } }, y: { channel: "PE-A" } })).toThrow();
  });

  it("matches biex reference values and refuses unvalidated parameter sets", async () => {
    const reference = JSON.parse(await fs.readFile(path.join(process.cwd(), "testdata/fixtures/biex-transform-reference.json"), "utf8"));
    for (const entry of reference.cases) {
      const mapping = buildPanelAxisMapping({ channel: "X", scale: "biex", transform: entry.parameters });
      const spline = entry.forwardSpline;
      for (const index of [0, Math.floor(spline.x.length / 2), spline.x.length - 1]) {
        expect(mapping.forward(spline.x[index])).toBeCloseTo(spline.y[index], 9);
      }
    }
    expect(() => buildPanelAxisMapping({ channel: "X", scale: "arcsinh", transform: { cofactor: 0 } })).toThrow();
    expect(() => buildPanelAxisMapping({ channel: "X", scale: "biex", transform: { maxRange: 123, pos: 4, neg: 0, width: -10, length: 256 } })).toThrow();
  });

  it("applies shared bounds groups to both panels exactly", async () => {
    const layout = structuredClone(strategy());
    layout.id = "group_bounds";
    layout.panels[1] = structuredClone(layout.panels[0]);
    layout.panels[1].id = "second";
    layout.boundsGroups = [{ id: "shared", channel: "FSC-A", scale: "linear", bounds: { min: 0, max: 1000 } }];
    for (const panel of layout.panels) panel.x = { channel: "FSC-A", scale: "linear", boundsGroup: "shared" };
    expect((await upsertLayout({ workspacePath, layout, expectedRevision: (await readWorkspace(workspacePath)).revision })).ok).toBe(true);
    const rendered = await renderLayout({ workspacePath, layoutId: layout.id, output: "content" });
    for (const panel of rendered.panels) expect(panel.visualBounds).toMatchObject({ xMin: 0, xMax: 1000 });
  });
  it("proposes deterministic ragged comparisons without modifying the workspace", async () => {
    const before = await fs.readFile(workspacePath, "utf8");
    const panels = ["alpha", "beta", "alpha"].map((sample) => ({
      source: { sample, parent: "root" }, x: { channel: "FSC-A" }, y: { channel: "SSC-A" },
    }));
    const input = { workspacePath, id: "proposed", name: "Comparison", panels, arrangement: "by_sample" as const };
    const first = await suggestComparisonLayout(input);
    expect(first.ok).toBe(true);
    expect(await suggestComparisonLayout(input)).toEqual(first);
    expect(first.layout.panels.map((panel) => [panel.position.x, panel.position.y])).toEqual([[0, 0], [0, 304], [344, 0]]);
    expect(await fs.readFile(workspacePath, "utf8")).toBe(before);
  });

  it("proposes strategy panels with the gate's actual parent and no inferred compensation", async () => {
    const before = await fs.readFile(workspacePath, "utf8");
    const workspace = await readWorkspace(workspacePath);
    const proposal = await suggestGatingStrategyLayout({ workspacePath, id: "strategy_proposal", name: "Strategy", sampleId: "alpha", arrangement: "tree" });
    expect(proposal.ok).toBe(true);
    expect(proposal.layout.panels).toHaveLength(workspace.gates.filter((gate) => gate.sample === "alpha").length);
    for (const panel of proposal.layout.panels) {
      const gate = workspace.gates.find((entry) => entry.id === panel.sources[0].gate)!;
      expect(panel.sources[0].parent).toBe(gate.parent);
      expect(panel.x.channel).toBe(gate.x);
      expect(panel.sources[0].compensationId).toBeUndefined();
    }
    expect(await fs.readFile(workspacePath, "utf8")).toBe(before);
  });

  it("rejects invalid generator geometry and reports unknown source references", async () => {
    await expect(suggestComparisonLayout({ workspacePath, id: "bad", name: "Bad", panels: [], columns: 0 })).rejects.toMatchObject({ code: "invalid_layout_columns" });
    await expect(suggestComparisonLayout({ workspacePath, id: "bad", name: "Bad", panels: [] })).rejects.toMatchObject({ code: "empty_layout" });
    const result = await suggestComparisonLayout({ workspacePath, id: "bad", name: "Bad", panels: [{ source: { sample: "missing", parent: "root" }, x: { channel: "FSC-A" } }] });
    expect(result.ok).toBe(false);
  });
  it("renders a resolved scatter panel and reports no compensation applied", async () => {
    const result = await renderLayout({ workspacePath, layoutId: strategy().id });
    expect(result.kind).toBe("gating_strategy");
    expect(result.rendered).toBe(2);
    expect(result.placeholders).toBe(0);

    const scatter = result.panels[0];
    expect(scatter.state).toBe("rendered");
    expect(scatter.x).toBe("FSC-A");
    expect(scatter.y).toBe("SSC-A");
    // No prefix on this axis, so nothing was recorded and nothing was applied.
    expect(scatter.sources?.[0].recordedCompensationId).toBeUndefined();
    expect(scatter.sources?.[0].applied.applied).toBe(false);
  });

  it("applies the recorded compensation on a fluorescence panel and reports it", async () => {
    const result = await renderLayout({ workspacePath, layoutId: strategy().id });
    const fluorescence = result.panels[1];

    expect(fluorescence.state).toBe("rendered");
    expect(fluorescence.x).toBe("FITC-A");
    expect(fluorescence.sources?.[0].recordedCompensationId).toBe("flowjo_alpha_shared-matrix-id");
    // The report states what was applied; it is not inferred from the request.
    expect(fluorescence.sources?.[0].applied).toMatchObject({
      applied: true,
      id: "flowjo_alpha_shared-matrix-id",
      source: "flowjo_wsp",
    });
    expect(fluorescence.sources?.[0].applied.channels).toContain("FITC-A");
  });

  it("uses imported biex parameters rather than preview defaults", async () => {
    const panel = layouts[0].panels[1];
    expect(panel.x.scale).toBe("biex");
    expect(panel.x.transform).toMatchObject({ width: -10, pos: 4.3, maxRange: 262144 });

    const unsupported = await renderLayout({ workspacePath, layoutId: layouts[0].id });
    expect(unsupported.panels[1].state).toBe("placeholder");
    expect(unsupported.panels[1].reason).toContain("not in the validated reference table");
    const layout = structuredClone(layouts[0]);
    layout.id = "validated_biex";
    for (const entry of layout.panels) for (const axis of [entry.x, entry.y]) {
      if (axis?.scale === "biex") axis.transform = { length: 256, maxRange: 262144, pos: 4.5, neg: 0, width: -10 };
    }
    expect((await upsertLayout({ workspacePath, layout, expectedRevision: (await readWorkspace(workspacePath)).revision })).ok).toBe(true);
    const result = await renderLayout({ workspacePath, layoutId: layout.id });
    expect(result.panels[1].state).toBe("rendered");
    expect(result.panels[1].scale?.x).toBe("biex");
    expect(result.panels[1].axisConfiguration?.x.transform).toEqual(layout.panels[1].x.transform);
  });

  it("compensation=\"none\" blocks recorded compensated gates rather than reporting invalid statistics", async () => {
    const asRecorded = await renderLayout({ workspacePath, layoutId: strategy().id });
    const raw = await renderLayout({ workspacePath, layoutId: strategy().id, compensation: "none" });

    expect(asRecorded.compensationMode).toBe("as_recorded");
    expect(raw.compensationMode).toBe("none");
    expect(asRecorded.panels[1].sources?.[0].applied.applied).toBe(true);
    expect(raw.panels[1].reason).toContain("compensation_space_mismatch");
    expect(raw.panels[1].previewSummary).toBeUndefined();
    expect(raw.panels[0].sources?.[0].applied.applied).toBe(false);
    expect(raw.image?.svg).not.toBe(asRecorded.image?.svg);
  });

  it("composites each panel byte-identically to a standalone render", async () => {
    const result = await renderLayout({ workspacePath, layoutId: strategy().id, output: "content" });
    const panel = strategy().panels[1];
    const source = panel.sources[0];

    // Same inputs through the same path the layout renderer used.
    const context = await getRenderablePlotContext({
      workspacePath,
      sampleId: source.sample,
      parent: source.parent,
      x: panel.x.channel,
      y: panel.y?.channel,
      compensationId: source.compensationId,
    });
    const standalone = renderPlotSvg(configurePlotAxes(context, { x: panel.x, y: panel.y! }), panel.position.width, panel.position.height, "layout_clip_1");

    // Only the root element's placement attributes differ; every child element
    // is carried over unchanged.
    const innerOf = (svg: string) => svg.slice(svg.indexOf(">") + 1);
    expect(result.image?.svg).toContain(innerOf(standalone));
    const ids = [...(result.image?.svg ?? "").matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["layout_clip_0", "layout_clip_1"]);
    for (const id of ids) expect(result.image?.svg).toContain(`url(#${id})`);
  });

  it("expands the viewport for negative and off-page panels without changing the stored page", async () => {
    const layout = structuredClone(strategy());
    layout.id = "off_page";
    layout.canvas = { width: 100, height: 100 };
    layout.panels[0].position.x = -80;
    layout.panels[1].position.x = 1287;
    expect((await upsertLayout({ workspacePath, layout, expectedRevision: (await readWorkspace(workspacePath)).revision })).ok).toBe(true);
    const before = await fs.readFile(workspacePath, "utf8");
    const result = await renderLayout({ workspacePath, layoutId: layout.id, output: "content" });
    expect(result.pageCanvas).toEqual({ width: 100, height: 100 });
    expect(result.viewport.x).toBe(-80);
    expect(result.canvas.width).toBeGreaterThan(1287 + 80);
    expect(await fs.readFile(workspacePath, "utf8")).toBe(before);
  });

  it("honors explicit panel bounds", async () => {
    const layout = structuredClone(strategy());
    layout.id = "explicit_bounds";
    layout.panels[0].x.bounds = { min: 1, max: 500 };
    layout.panels[0].x.scale = "linear";
    expect((await upsertLayout({ workspacePath, layout, expectedRevision: (await readWorkspace(workspacePath)).revision })).ok).toBe(true);
    const result = await renderLayout({ workspacePath, layoutId: layout.id, output: "content" });
    expect(result.panels[0].state).toBe("rendered");
    expect(result.panels[0].visualBounds).toMatchObject({ xMin: 1, xMax: 500 });
  });

  it("renders the comparison layout as plots plus labelled placeholders", async () => {
    const result = await renderLayout({ workspacePath, layoutId: comparison().id });
    expect(result.kind).toBe("comparison");

    const rendered = result.panels.filter((panel) => panel.state === "rendered");
    const placeholders = result.panels.filter((panel) => panel.state === "placeholder");
    expect(rendered).toHaveLength(2);
    expect(placeholders).toHaveLength(5);

    // Each rendered panel used its own sample's matrix.
    for (const panel of rendered) {
      const applied = panel.sources?.[0].applied;
      expect(applied?.applied).toBe(true);
      expect(applied?.id).toContain(panel.sources?.[0].sample);
    }

    // Every placeholder states why, and none is drawn as data.
    for (const panel of placeholders) {
      expect(panel.reason).toBeTruthy();
      expect(panel.sources).toBeUndefined();
    }
    expect(result.image?.svg).toContain("NOT RENDERED");
    expect(placeholders.some((panel) => panel.reason?.includes("unknown_sample"))).toBe(true);
    expect(placeholders.some((panel) => panel.reason?.includes("unresolved_compensation"))).toBe(true);
    expect(placeholders.some((panel) => panel.reason?.includes("unresolved_transform"))).toBe(true);
  });

  it("never draws a partial panel as a plot", async () => {
    const result = await renderLayout({ workspacePath, layoutId: comparison().id });
    const partialIds = comparison().panels
      .filter((panel) => panel.status.state === "partial")
      .map((panel) => panel.id);
    expect(partialIds.length).toBeGreaterThan(0);
    for (const id of partialIds) {
      expect(result.panels.find((panel) => panel.id === id)?.state).toBe("placeholder");
    }
  });

  it("writes a deterministic SVG under the workspace cache", async () => {
    const first = await renderLayout({ workspacePath, layoutId: strategy().id });
    const second = await renderLayout({ workspacePath, layoutId: strategy().id });
    expect(first.image?.path).toBe(second.image?.path);
    expect(first.image?.svg).toBe(second.image?.svg);
    expect(first.image?.path).toContain(path.join(".datalox", "cache", "layouts"));
    expect(await fs.readFile(first.image?.path as string, "utf8")).toBe(first.image?.svg);
  });

  it("refuses a layout with more panels than the cap", async () => {
    await expect(renderLayout({ workspacePath, layoutId: comparison().id, maxPanels: 2 }))
      .rejects.toMatchObject({ code: "layout_too_many_panels" });
  });

  it("omits the image for the agent-readable path", async () => {
    const result = await renderLayout({ workspacePath, layoutId: strategy().id, withoutImage: true });
    expect(result.image).toBeUndefined();
    expect(result.panels).toHaveLength(2);
    expect(result.panels[0].previewSummary).toBeDefined();
  });
});
