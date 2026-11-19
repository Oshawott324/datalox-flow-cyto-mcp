import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  importFlowJoWorkspace,
  readWorkspace,
  validateWorkspace,
  type FlowcytoLayout,
  type LayoutPanel,
} from "../src/core/index.js";

const fixtureWsp = path.join(process.cwd(), "testdata", "fixtures", "flowjo", "layouts.wsp");

/** Three channels; FITC-A carries FL03-A as its $PnS marker so the Comp-FL03-A
 *  axis in the fixture must resolve through the alias, not by string equality. */
async function writeFcs(fcsPath: string): Promise<void> {
  const channels = ["FSC-A", "SSC-A", "FITC-A"];
  const markers: Array<string | undefined> = [undefined, undefined, "FL03-A"];
  const rows = [[100, 200, 300], [150, 250, 350], [200, 300, 400]];
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

async function importFixture(overrides: Record<string, unknown> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-layout-wsp-"));
  const alpha = path.join(dir, "alpha.fcs");
  const beta = path.join(dir, "beta.fcs");
  await writeFcs(alpha);
  await writeFcs(beta);
  const result = await importFlowJoWorkspace({
    wspPath: fixtureWsp,
    workspaceDir: dir,
    samplePathMap: { "alpha.fcs": alpha, "beta.fcs": beta },
    sampleIdMap: { "alpha.fcs": "alpha", "beta.fcs": "beta" },
    ...overrides,
  });
  return { dir, result, alpha, beta };
}

let layouts: FlowcytoLayout[] = [];
let panels: LayoutPanel[] = [];
let importResult: Awaited<ReturnType<typeof importFlowJoWorkspace>>;

beforeAll(async () => {
  const { result } = await importFixture();
  importResult = result;
  const workspace = await readWorkspace(result.workspacePath);
  layouts = workspace.layouts ?? [];
  panels = layouts.flatMap((layout) => layout.panels);
});

const panelById = (id: string) => panels.find((panel) => panel.id.includes(id));

describe("FlowJo layout import", () => {
  it("preserves every layout and every panel, resolving only what binds", () => {
    expect(layouts).toHaveLength(2);
    expect(panels).toHaveLength(6);
    expect(importResult.layoutPanels).toEqual({
      total: 6,
      resolved: 4,
      unresolved: 2,
      unresolvedByReason: { unknown_sample: 1, unsupported_feature: 1 },
    });
  });

  it("classifies layouts by population path, not by resolved gate id", () => {
    // Each sample has its own gate id for "Live", so classifying on gate ids would
    // make the comparison layout look like unrelated populations.
    expect(layouts[0]).toMatchObject({ name: "strategy", kind: "gating_strategy" });
    expect(layouts[1]).toMatchObject({ name: "compare", kind: "comparison" });
  });

  it("retains a DataLayer whose sample has a SampleRef but no SampleNode", () => {
    const panel = panels.find((entry) =>
      entry.status.state === "unresolved" && entry.status.reason === "unknown_sample");
    expect(panel).toBeDefined();
    expect(panel?.status).toMatchObject({ state: "unresolved", reason: "unknown_sample" });
    if (panel?.status.state !== "unresolved") throw new Error("expected unresolved");
    expect(panel.status.detail).toContain("sampleID=99");
    expect(panel.status.detail).toContain("SampleRef");
    // No sample or population may be invented to fill the gap.
    expect(panel.sources).toEqual([]);
    // The original reference survives for export and inspection.
    expect(panel._flowjo?.PopModelList).toBeDefined();
  });

  it("reports an unmodelled Multigraph grid instead of importing a wrong panel", () => {
    const panel = panels.find((entry) =>
      entry.status.state === "unresolved" && entry.status.reason === "unsupported_feature");
    if (panel?.status.state !== "unresolved") throw new Error("expected unresolved");
    expect(panel.status.detail).toContain("Multigraph");
    expect(panel.sources).toEqual([]);
  });

  it("resolves axis names through sample parameter metadata, including the Comp- prefix", () => {
    const panel = panelById("strategy_panel_2");
    expect(panel?.status).toEqual({ state: "resolved" });
    // XML says Comp-FL03-A: strip the declared prefix, then resolve FL03-A through
    // the $PnS marker to the real parameter name.
    expect(panel?.x.channel).toBe("FITC-A");
    expect(panel?.y?.channel).toBe("SSC-A");
  });

  it("takes panel size from WindowPosition when ChartData geometry is zero", () => {
    expect(panelById("strategy_panel_1")?.position).toEqual({ x: 10, y: 10, width: 256, height: 256 });
    // This ChartData carries width="0" height="0".
    expect(panelById("strategy_panel_2")?.position).toEqual({ x: 300, y: 10, width: 256, height: 256 });
  });

  it("records an explicit compensation reference rather than implying raw data", () => {
    const compensated = panelById("strategy_panel_2")?.sources[0];
    expect(compensated?.compensationId).toBeUndefined();
    expect(compensated?.unresolvedCompensation?.reference).toBe("Comp-FL03-A");
    expect(compensated?.unresolvedCompensation?.detail).toContain("Acquisition-defined");
    expect(compensated?.unresolvedCompensation?.detail).not.toMatch(/uncompensated/i);

    // An axis with no prefix carries no reference, which is also not a claim.
    const plain = panelById("strategy_panel_1")?.sources[0];
    expect(plain?.unresolvedCompensation).toBeUndefined();
    expect(plain?.compensationId).toBeUndefined();

    expect(importResult.layoutCompensationReferences).toEqual({ unresolved: 1, absent: 7 });
  });

  it("binds each comparison panel to its own sample's gate id", () => {
    const comparison = layouts[1].panels.filter((panel) => panel.status.state === "resolved");
    expect(comparison).toHaveLength(2);
    const samples = comparison.map((panel) => panel.sources[0].sample);
    expect(samples).toEqual(["alpha", "beta"]);
    // Same FlowJo path, different resolved gate ids.
    const parents = comparison.map((panel) => panel.sources[0].parent);
    expect(new Set(parents).size).toBe(2);
  });

  it("produces a workspace that passes validation", async () => {
    const { result } = await importFixture();
    expect((await validateWorkspace(result.workspacePath)).ok).toBe(true);
  });

  it("leaves the source .wsp untouched and writes nothing in a dry run", async () => {
    const before = createHash("sha256").update(await fs.readFile(fixtureWsp)).digest("hex");
    const { result, alpha } = await importFixture({ dryRun: true });
    const alphaHash = createHash("sha256").update(await fs.readFile(alpha)).digest("hex");

    expect(result.dryRun).toBe(true);
    expect(result.layoutPanels.resolved).toBe(4);
    await expect(fs.access(result.workspacePath)).rejects.toThrow();
    expect(createHash("sha256").update(await fs.readFile(fixtureWsp)).digest("hex")).toBe(before);
    // The FCS is read for metadata only.
    expect(createHash("sha256").update(await fs.readFile(alpha)).digest("hex")).toBe(alphaHash);
  });

  it("can skip layouts entirely", async () => {
    const { result } = await importFixture({ importLayouts: false });
    expect(result.layoutsImported).toBe(0);
    expect((await readWorkspace(result.workspacePath)).layouts ?? []).toEqual([]);
  });
});
