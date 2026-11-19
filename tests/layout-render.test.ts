import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { renderLayout } from "../src/app/gate-editor/layout-image.js";
import { renderPlotSvg } from "../src/app/gate-editor/plot-image.js";
import { getRenderablePlotContext } from "../src/app/gate-editor/server.js";
import {
  importFlowJoWorkspace,
  readWorkspace,
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
});

const strategy = () => layouts[0];
const comparison = () => layouts[1];

describe("layout rendering", () => {
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

  it("uses the imported biex transform parameters for the panel scale", async () => {
    const panel = strategy().panels[1];
    expect(panel.x.scale).toBe("biex");
    expect(panel.x.transform).toMatchObject({ width: -10, pos: 4.3, maxRange: 262144 });

    const result = await renderLayout({ workspacePath, layoutId: strategy().id });
    expect(result.panels[1].scale?.x).toBeDefined();
  });

  it("compensation=\"none\" renders raw and says so, rather than silently differing", async () => {
    const asRecorded = await renderLayout({ workspacePath, layoutId: strategy().id });
    const raw = await renderLayout({ workspacePath, layoutId: strategy().id, compensation: "none" });

    expect(asRecorded.compensationMode).toBe("as_recorded");
    expect(raw.compensationMode).toBe("none");
    expect(asRecorded.panels[1].sources?.[0].applied.applied).toBe(true);
    expect(raw.panels[1].sources?.[0].applied.applied).toBe(false);
    // The layout still records its configuration; only the render differs.
    expect(raw.panels[1].sources?.[0].recordedCompensationId).toBe("flowjo_alpha_shared-matrix-id");
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
    const standalone = renderPlotSvg(context, panel.position.width, panel.position.height);

    // Only the root element's placement attributes differ; every child element
    // is carried over unchanged.
    const innerOf = (svg: string) => svg.slice(svg.indexOf(">") + 1);
    expect(result.image?.svg).toContain(innerOf(standalone));
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
