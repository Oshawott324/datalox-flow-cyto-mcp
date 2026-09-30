import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

import {
  estimateCompensationFromControls,
  estimateCompensationFromGatedControls,
  getChannelHistogram,
  getEventPreview,
  getPopulationDensity,
  getPopulationEvents,
  getPopulationGraph,
  getPopulationStats,
  initWorkspace,
  openFcsArtifact,
  readWorkspace,
  upsertGate,
  upsertGates,
  type WorkspaceGate,
} from "../src/core/index.js";

async function writeIntegerFcs(params: {
  fcsPath: string;
  channels: string[];
  markers?: string[];
  rows: number[][];
}): Promise<void> {
  const data = Buffer.alloc(params.rows.length * params.channels.length * 2);
  let cursor = 0;
  for (const row of params.rows) {
    for (const value of row) {
      data.writeUInt16LE(value, cursor);
      cursor += 2;
    }
  }
  const textSegment = (beginData: number, endData: number) => {
    const entries = [
      "$BEGINANALYSIS", "0",
      "$BEGINDATA", String(beginData).padStart(12, "0"),
      "$BYTEORD", "1,2,3,4",
      "$DATATYPE", "I",
      "$ENDANALYSIS", "0",
      "$ENDDATA", String(endData).padStart(12, "0"),
      "$MODE", "L",
      "$NEXTDATA", "0",
      "$PAR", String(params.channels.length),
      "$TOT", String(params.rows.length),
    ];
    params.channels.forEach((channel, index) => {
      const number = index + 1;
      entries.push(`$P${number}B`, "16", `$P${number}N`, channel, `$P${number}R`, "65535");
      const marker = params.markers?.[index];
      if (marker) entries.push(`$P${number}S`, marker);
    });
    return `|${entries.join("|")}|`;
  };
  const textStart = 58;
  const dataStart = textStart + textSegment(0, 0).length;
  const dataEnd = dataStart + data.length - 1;
  const text = textSegment(dataStart, dataEnd);
  const pad = (value: number) => String(value).padStart(8);
  const header = `FCS3.1    ${pad(textStart)}${pad(textStart + text.length - 1)}${pad(dataStart)}${pad(dataEnd)}${pad(0)}${pad(0)}`;
  await fs.writeFile(params.fcsPath, Buffer.concat([Buffer.from(header, "ascii"), Buffer.from(text, "latin1"), data]));
}

const LARGE = 60_000;

async function largeWorkspace(): Promise<{ workspacePath: string; bright: number[] }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-popevents-"));
  const samplePath = path.join(dir, "sample.fcs");
  const rows: number[][] = [];
  const bright: number[] = [];
  for (let index = 0; index < LARGE; index += 1) {
    const isBright = index % 7 === 0;
    if (isBright) bright.push(index);
    rows.push([index % 1000, isBright ? 5000 + (index % 100) : index % 50]);
  }
  await writeIntegerFcs({ fcsPath: samplePath, channels: ["FS-A", "FL1-A"], markers: ["FSC", "CD3 FITC"], rows });
  const { workspacePath } = await initWorkspace({ rootDir: dir, samplePath, sampleId: "sample" });
  const workspace = await readWorkspace(workspacePath);
  await upsertGate({
    workspacePath,
    expectedRevision: workspace.revision,
    gate: { id: "bright", name: "Bright", sample: "sample", parent: "root", type: "range", x: "CD3 FITC", min: 1000, max: 65535 },
  });
  return { workspacePath, bright };
}

describe("exact population measurements", () => {
  it("measures every event of a large sample where previews stride-sample", async () => {
    const { workspacePath, bright } = await largeWorkspace();

    const preview = await getEventPreview({ workspacePath, sampleId: "sample", x: "FSC", y: "CD3 FITC", format: "points", maxEvents: 50_000 });
    expect(preview.sampledEvents).toBeLessThan(LARGE);

    const all = await getPopulationStats({ workspacePath, sampleId: "sample", channels: ["CD3 FITC"] });
    expect(all.populationEvents).toBe(LARGE);
    expect(all.channels[0]?.count).toBe(LARGE);

    const gated = await getPopulationStats({ workspacePath, sampleId: "sample", channels: ["CD3 FITC", "FSC"], parent: "bright", percentiles: [0, 50, 100] });
    expect(gated.populationEvents).toBe(bright.length);
    expect(gated.channels[0]).toMatchObject({ channel: "CD3 FITC", count: bright.length, min: 5000, max: 5099 });
    expect(gated.channels[0]?.percentiles["0"]).toBe(5000);
    expect(gated.channels[0]?.percentiles["100"]).toBe(5099);

    const graph = await getPopulationGraph({ workspacePath, sampleId: "sample" });
    expect(graph.root.children[0]?.count).toBe(bright.length);
  });

  it("accepts a detector id wherever a parameter name is expected and reports the parameter name", async () => {
    const { workspacePath } = await largeWorkspace();
    const stats = await getPopulationStats({ workspacePath, sampleId: "sample", channels: ["FL1-A"], parent: "bright" });
    expect(stats.channels[0]?.channel).toBe("CD3 FITC");
    await expect(getPopulationStats({ workspacePath, sampleId: "sample", channels: ["FL9-A"] }))
      .rejects.toMatchObject({ code: "unknown_parameter" });
  });

  it("pages through a population without losing or repeating events", async () => {
    const { workspacePath, bright } = await largeWorkspace();
    const first = await getPopulationEvents({ workspacePath, sampleId: "sample", channels: ["CD3 FITC"], limit: 50_000 });
    expect(first.populationEvents).toBe(LARGE);
    expect(first.returnedEvents).toBe(50_000);
    expect(first.nextOffset).toBe(50_000);
    const second = await getPopulationEvents({ workspacePath, sampleId: "sample", channels: ["CD3 FITC"], offset: 50_000, limit: 50_000 });
    expect(second.returnedEvents).toBe(LARGE - 50_000);
    expect(second.nextOffset).toBeNull();
    expect(second.eventIndexes[0]).toBe(50_000);

    const page = await getPopulationEvents({ workspacePath, sampleId: "sample", channels: ["FSC", "CD3 FITC"], parent: "bright", offset: 10, limit: 5 });
    expect(page.eventIndexes).toEqual(bright.slice(10, 15));
    expect(page.rows[0]).toEqual([bright[10]! % 1000, 5000 + (bright[10]! % 100)]);

    await expect(getPopulationEvents({ workspacePath, sampleId: "sample", channels: ["FSC"], limit: 50_001 }))
      .rejects.toMatchObject({ code: "invalid_limit" });

    // A page is one MCP message, so wide pages are capped by total values.
    const wide = ["FSC", "CD3 FITC", "FS-A", "FL1-A"];
    await expect(getPopulationEvents({ workspacePath, sampleId: "sample", channels: wide, limit: 25_001 }))
      .rejects.toMatchObject({ code: "invalid_limit" });
    const widePage = await getPopulationEvents({ workspacePath, sampleId: "sample", channels: wide, limit: 25_000 });
    expect(widePage.returnedEvents).toBe(25_000);
    expect(widePage.maxLimit).toBe(25_000);
  });

  it("builds histograms over all events with edges in raw units", async () => {
    const { workspacePath, bright } = await largeWorkspace();
    const linear = await getChannelHistogram({ workspacePath, sampleId: "sample", channel: "CD3 FITC", bins: 10, min: 0, max: 10_000 });
    expect(linear.populationEvents).toBe(LARGE);
    expect(linear.counts.reduce((sum, count) => sum + count, 0)).toBe(LARGE);
    expect(linear.counts[0]).toBe(LARGE - bright.length);
    expect(linear.counts[5]).toBe(bright.length);
    expect(linear.edges[5]).toBeCloseTo(5000);

    // Values of zero cannot be placed on a log axis; they are reported, not dropped silently.
    const log = await getChannelHistogram({ workspacePath, sampleId: "sample", channel: "CD3 FITC", scale: "log", bins: 8 });
    const zeros = LARGE / 50 - bright.filter((index) => index % 50 === 0).length;
    expect(log.notRepresentable).toBe(zeros);
    expect(log.counts.reduce((sum, count) => sum + count, 0) + log.notRepresentable).toBe(LARGE);

    const arcsinh = await getChannelHistogram({ workspacePath, sampleId: "sample", channel: "CD3 FITC", parent: "bright", scale: "arcsinh", cofactor: 100, bins: 4 });
    expect(arcsinh.populationEvents).toBe(bright.length);
    expect(arcsinh.edges[0]).toBeCloseTo(5000);
    expect(arcsinh.edges[4]).toBeCloseTo(5099);
  });

  it("builds a two-dimensional density over all events", async () => {
    const { workspacePath, bright } = await largeWorkspace();
    const density = await getPopulationDensity({
      workspacePath, sampleId: "sample", x: "FSC", y: "FL1-A", bins: 2,
      xAxis: { min: 0, max: 1000 }, yAxis: { min: 0, max: 10_000 },
    });
    expect(density).toMatchObject({ x: "FSC", y: "CD3 FITC", populationEvents: LARGE, outsideRange: 0 });
    const total = density.counts.flat().reduce((sum, count) => sum + count, 0);
    expect(total).toBe(LARGE);
    // row 1 is the upper half of the y range, where only the bright events sit
    expect(density.counts[1]!.reduce((sum, count) => sum + count, 0)).toBe(bright.length);
    expect(density.xEdges).toEqual([0, 500, 1000]);
  });

  it("names the parameter when a gate is written with a detector id", async () => {
    const { workspacePath } = await largeWorkspace();
    const workspace = await readWorkspace(workspacePath);
    const result = await upsertGate({
      workspacePath,
      expectedRevision: workspace.revision,
      gate: { id: "by_detector", sample: "sample", parent: "root", type: "range", x: "FL1-A", min: 0, max: 10 },
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("unknown_parameter");
    expect(result.errors[0]?.message).toContain('FL1-A is the detector of parameter "CD3 FITC"');
  });
});

describe("compensation from gated controls", () => {
  // A cell control: mostly debris, some unstained cells with autofluorescence,
  // and a minority of stained cells. True spillover is 0.10 (FITC into PE) and
  // 0.05 (PE into FITC).
  function controlRows(own: 0 | 1, spill: number): number[][] {
    const rows: number[][] = [];
    for (let index = 0; index < 900; index += 1) rows.push([10 + (index % 3), 10 + (index % 3)]);
    for (let index = 0; index < 60; index += 1) rows.push([200 + (index % 5), 100 + (index % 5)]);
    for (let index = 0; index < 40; index += 1) {
      const signal = 4000 + index * 10;
      const row = [200, 100];
      row[own] = row[own]! + signal;
      row[1 - own] = row[1 - own]! + Math.round(signal * spill);
      rows.push(row);
    }
    return rows;
  }

  async function controlWorkspace(): Promise<{ dir: string; workspacePath: string }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-gated-comp-"));
    await writeIntegerFcs({ fcsPath: path.join(dir, "fitc.fcs"), channels: ["FL1-A", "FL2-A"], rows: controlRows(0, 0.1) });
    await writeIntegerFcs({ fcsPath: path.join(dir, "pe.fcs"), channels: ["FL1-A", "FL2-A"], rows: controlRows(1, 0.05) });
    const rowsUnstained: number[][] = [];
    for (let index = 0; index < 500; index += 1) rowsUnstained.push([200 + (index % 5), 100 + (index % 5)]);
    await writeIntegerFcs({ fcsPath: path.join(dir, "unstained.fcs"), channels: ["FL1-A", "FL2-A"], rows: rowsUnstained });
    const opened = await openFcsArtifact({ path: path.join(dir, "fitc.fcs"), workspaceDir: dir, sampleId: "fitc" });
    await openFcsArtifact({ path: path.join(dir, "pe.fcs"), workspaceDir: dir, sampleId: "pe" });
    await openFcsArtifact({ path: path.join(dir, "unstained.fcs"), workspaceDir: dir, sampleId: "unstained" });
    const workspace = await readWorkspace(opened.workspacePath);
    const gates: WorkspaceGate[] = [
      { id: "fitc_pos", sample: "fitc", parent: "root", type: "range", x: "FL1-A", min: 2000, max: 65535 },
      { id: "fitc_neg", sample: "fitc", parent: "root", type: "range", x: "FL1-A", min: 150, max: 300 },
      { id: "pe_pos", sample: "pe", parent: "root", type: "range", x: "FL2-A", min: 2000, max: 65535 },
      { id: "pe_neg", sample: "pe", parent: "root", type: "range", x: "FL2-A", min: 80, max: 150 },
      { id: "unstained_cells", sample: "unstained", parent: "root", type: "range", x: "FL1-A", min: 150, max: 300 },
    ];
    await upsertGates({ workspacePath: opened.workspacePath, gates, expectedRevision: workspace.revision });
    return { dir, workspacePath: opened.workspacePath };
  }

  it("recovers the true spillover where whole-file medians do not", async () => {
    const { dir, workspacePath } = await controlWorkspace();
    const gated = await estimateCompensationFromGatedControls({
      workspacePath,
      id: "run_controls",
      controls: [
        { sampleId: "fitc", channel: "FL1-A", positiveGateId: "fitc_pos", negativeGateId: "fitc_neg" },
        { sampleId: "pe", channel: "FL2-A", positiveGateId: "pe_pos", negativeGateId: "pe_neg" },
      ],
    });
    expect(gated.compensation).toMatchObject({ id: "run_controls", source: "controls", channels: ["FL1-A", "FL2-A"] });
    expect(gated.compensation.matrix[0]![1]).toBeCloseTo(0.1, 2);
    expect(gated.compensation.matrix[1]![0]).toBeCloseTo(0.05, 2);
    expect(gated.diagnostics.controls[0]).toMatchObject({ positiveEvents: 40, negativeEvents: 60 });

    const wholeFile = await estimateCompensationFromControls({
      channels: ["FL1-A", "FL2-A"],
      controls: [
        { path: path.join(dir, "fitc.fcs"), channel: "FL1-A" },
        { path: path.join(dir, "pe.fcs"), channel: "FL2-A" },
      ],
    });
    expect(Math.abs(wholeFile.compensation.matrix[0]![1]! - 0.1)).toBeGreaterThan(0.5);
  });

  it("takes the negative population from another sample when asked", async () => {
    const { workspacePath } = await controlWorkspace();
    const gated = await estimateCompensationFromGatedControls({
      workspacePath,
      controls: [
        { sampleId: "fitc", channel: "FL1-A", positiveGateId: "fitc_pos", negativeGateId: "unstained_cells", negativeSampleId: "unstained" },
        { sampleId: "pe", channel: "FL2-A", positiveGateId: "pe_pos", negativeGateId: "unstained_cells", negativeSampleId: "unstained" },
      ],
    });
    expect(gated.compensation.matrix[0]![1]).toBeCloseTo(0.1, 2);
    expect(gated.compensation.matrix[1]![0]).toBeCloseTo(0.05, 2);
    expect(gated.diagnostics.controls[0]?.negativeSampleId).toBe("unstained");
  });

  it("refuses populations that do not separate", async () => {
    const { workspacePath } = await controlWorkspace();
    await expect(estimateCompensationFromGatedControls({
      workspacePath,
      controls: [{ sampleId: "fitc", channel: "FL1-A", positiveGateId: "fitc_neg", negativeGateId: "fitc_pos" }],
    })).rejects.toMatchObject({ code: "insufficient_control_signal" });
  });
});

describe("headless MCP server", () => {
  async function listed(env: Record<string, string>) {
    const client = new Client({ name: "flowcyto-headless-test", version: "0.0.0" });
    const transport = new StdioClientTransport({
      command: "node",
      args: [path.resolve("dist/src/mcp/server.js")],
      env: { ...(process.env as Record<string, string>), ...env },
      stderr: "ignore",
    });
    await client.connect(transport);
    return client;
  }

  it("hides the gate-editor tools and editor guidance, and keeps the measurement tools", async () => {
    const { workspacePath } = await largeWorkspace();
    const headless = await listed({ FLOWCYTO_HEADLESS: "1" });
    try {
      const names = (await headless.listTools()).tools.map((tool) => tool.name);
      expect(names).not.toContain("open_gate_editor");
      expect(names).not.toContain("render_gate_editor");
      for (const name of ["get_population_stats", "get_channel_histogram", "get_population_events", "estimate_compensation_from_gated_controls", "upsert_gate"]) {
        expect(names).toContain(name);
      }
      const opened = await headless.callTool({ name: "open_fcs", arguments: { path: workspacePath } });
      const result = (opened.structuredContent as { result: Record<string, unknown> }).result;
      expect(result.ok).toBe(true);
      expect(result).not.toHaveProperty("agentContract");
      expect(result).not.toHaveProperty("gateEditorPolicy");
      expect((result.nextAction as { tool: string }).tool).toBe("render_plot");

      const stats = await headless.callTool({
        name: "get_population_stats",
        arguments: { workspace_path: workspacePath, sample_id: "sample", channels: ["FL1-A"], parent_gate_id: "bright" },
      });
      const statsResult = (stats.structuredContent as { result: { populationEvents: number } }).result;
      expect(statsResult.populationEvents).toBe(Math.ceil(LARGE / 7));
    } finally {
      await headless.close();
    }
  });

  it("is unchanged by default", async () => {
    const { workspacePath } = await largeWorkspace();
    const client = await listed({ FLOWCYTO_HEADLESS: "0" });
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("open_gate_editor");
      expect(names).toContain("get_population_stats");
      const opened = await client.callTool({ name: "open_fcs", arguments: { path: workspacePath, surface: "none" } });
      const result = (opened.structuredContent as { result: Record<string, unknown> }).result;
      expect(result).toHaveProperty("agentContract");
    } finally {
      await client.close();
    }
  });
});
