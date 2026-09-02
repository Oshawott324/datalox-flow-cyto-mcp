import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";

import {
  isLocalGateEditorPreviewUrl,
  macGateEditorWindowScript,
  nativeGateEditorLaunchPlan,
  nativeGateEditorReadiness,
  nativeGateEditorReadinessError,
  nativeGateEditorRuntimeForPlatform,
  parseNativeWindowErrorPayload,
  supportsNativeGateEditorWindow,
  windowsWebView2HelperPath,
  windowsWebView2LoaderPath,
} from "../src/app/gate-editor/native-window.js";
import { renderPlotImage } from "../src/app/gate-editor/plot-image.js";
import { recommendedAxes, startGateEditorServer } from "../src/app/gate-editor/server.js";
import {
  alignCompensationMatrix,
  applyCompensationColumns,
  deleteGate,
  detectCompensationStatus,
  extractSpilloverMatrices,
  formatTick,
  FlowcytoError,
  generateTicks,
  getEventPreview,
  getSampleMetadata,
  initWorkspace,
  openFcsArtifact,
  readPreviewColumns,
  readWorkspace,
  transformValue,
  upsertGate,
  validateWorkspace,
  watchWorkspaceFile,
  writeWorkspace,
  type CompensationMatrix,
  type FlowcytoWorkspace,
  type WorkspaceGate,
} from "../src/core/index.js";

const execFileAsync = promisify(execFile);
const fixturePath = path.resolve("testdata/fixtures/CFP_Well_A4.fcs");
const fixtureManifestPath = path.resolve("testdata/fixtures/manifest.json");

type FixtureManifest = {
  fixtures: Array<{
    id: string;
    path: string;
    expected?: {
      minParameters?: number;
      minEvents?: number;
      requiredKeywords?: string[];
    };
  }>;
};

async function readFixtureManifest(): Promise<FixtureManifest> {
  return JSON.parse(await fs.readFile(fixtureManifestPath, "utf8")) as FixtureManifest;
}

async function makeWorkspaceFromFixture(
  sourceFixturePath: string,
  sampleId = "sample_001",
): Promise<{ dir: string; workspacePath: string; workspace: FlowcytoWorkspace }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-test-"));
  await fs.mkdir(path.join(dir, "data"));
  await fs.copyFile(sourceFixturePath, path.join(dir, "data", "sample.fcs"));
  const result = await initWorkspace({
    rootDir: dir,
    samplePath: path.join(dir, "data", "sample.fcs"),
    sampleId,
  });
  return { dir, workspacePath: result.workspacePath, workspace: result.workspace };
}

async function makeWorkspace(): Promise<{ dir: string; workspacePath: string; workspace: FlowcytoWorkspace }> {
  return makeWorkspaceFromFixture(fixturePath);
}

async function writeTinyIntegerFcs(params: {
  fcsPath: string;
  channels: string[];
  markers?: Array<string | undefined>;
  rows: number[][];
  extraKeywords?: Record<string, string>;
}): Promise<void> {
  const bytesPerValue = 2;
  const data = Buffer.alloc(params.rows.length * params.channels.length * bytesPerValue);
  let cursor = 0;
  for (const row of params.rows) {
    for (const value of row) {
      data.writeUInt16LE(value, cursor);
      cursor += bytesPerValue;
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
    for (const [key, value] of Object.entries(params.extraKeywords ?? {})) {
      entries.push(key, value);
    }
    return `|${entries.join("|")}|`;
  };

  const textStart = 58;
  const firstText = textSegment(0, 0);
  const dataStart = textStart + firstText.length;
  const dataEnd = dataStart + data.length - 1;
  const text = textSegment(dataStart, dataEnd);
  const header = `FCS3.1    ${String(textStart).padStart(8)}${String(textStart + text.length - 1).padStart(8)}${String(dataStart).padStart(8)}${String(dataEnd).padStart(8)}${String(0).padStart(8)}${String(0).padStart(8)}`;
  expect(Buffer.byteLength(header, "ascii")).toBe(58);
  await fs.writeFile(params.fcsPath, Buffer.concat([Buffer.from(header, "ascii"), Buffer.from(text, "latin1"), data]));
}

function testGate(id = "gate_1"): WorkspaceGate {
  return {
    id,
    name: "Gate 1",
    sample: "sample_001",
    parent: "root",
    type: "polygon",
    x: "HDR-T",
    y: "FSC-A",
    vertices: [
      [10, 10],
      [100, 10],
      [100, 100],
    ],
  };
}

async function waitFor<T>(action: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = action();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition.");
}

function waitForJsonStdout<T>(child: ChildProcess, timeoutMs = 3000): Promise<T> {
  if (!child.stdout || !child.stderr) {
    return Promise.reject(new Error("Process was not started with stdout and stderr pipes."));
  }
  return new Promise<T>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Process did not print startup JSON within ${timeoutMs}ms. stderr: ${stderr}`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdout += chunk.toString("utf8");
      try {
        const parsed = JSON.parse(stdout) as T;
        settled = true;
        clearTimeout(timer);
        resolve(parsed);
      } catch {
        // Wait for the rest of the pretty-printed JSON object.
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Process exited before startup JSON. code=${code ?? "null"} signal=${signal ?? "null"} stderr=${stderr}`));
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve();
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function makeSseReader(response: Response): {
  nextEvent(eventName: string, timeoutMs?: number): Promise<unknown>;
  cancel(): Promise<void>;
} {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SSE response has no body.");
  const decoder = new TextDecoder();
  let buffer = "";

  function parseBuffered(eventName: string): unknown | undefined {
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const lines = block.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice("event: ".length);
      const data = lines
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length))
        .join("\n");
      if (event === eventName) return data ? JSON.parse(data) as unknown : {};
      boundary = buffer.indexOf("\n\n");
    }
    return undefined;
  }

  return {
    async nextEvent(eventName: string, timeoutMs = 2000): Promise<unknown> {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const parsed = parseBuffered(eventName);
        if (parsed !== undefined) return parsed;
        const remaining = Math.max(1, timeoutMs - (Date.now() - started));
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${eventName}.`)), remaining)),
        ]);
        if (result.done) throw new Error(`SSE stream closed before ${eventName}.`);
        buffer += decoder.decode(result.value, { stream: true });
      }
      throw new Error(`Timed out waiting for ${eventName}.`);
    },
    async cancel(): Promise<void> {
      await reader.cancel();
    },
  };
}

describe("flowcyto core", () => {
  it("shares deterministic scale transforms, ticks, and labels", () => {
    expect(transformValue(150, "arcsinh")).toBeCloseTo(Math.asinh(1));
    expect(transformValue(1000, "log")).toBe(3);
    expect(transformValue(-1, "log")).toBeNaN();
    expect(generateTicks(0, 10, 3)).toEqual([0, 5, 10]);
    expect(formatTick(1_500_000)).toBe("1.5M");
    expect(formatTick(12_000)).toBe("12K");
  });

  it("prefers FSC/SSC area channels over leading timing parameters", () => {
    const axes = recommendedAxes({
      sampleId: "tet_sample",
      path: "sample.fcs",
      eventCount: 1,
      keywords: {},
      parameters: [
        { name: "TLSW", index: 0 },
        { name: "TMSW", index: 1 },
        { name: "Event Info", index: 2 },
        { name: "FSC 488/10-H", index: 3 },
        { name: "FSC 488/10-A", index: 4 },
        { name: "SSC 488/10-H", index: 5 },
        { name: "SSC 488/10-A", index: 6 },
      ],
    });
    expect(axes).toEqual({ x: "FSC 488/10-A", y: "SSC 488/10-A" });
  });

  it("parses embedded spillover keywords with stable ids", () => {
    const bd = extractSpilloverMatrices({
      keywords: { $SPILLOVER: "2,FITC-A,PE-A,1,0.2,0.1,1" },
      sampleId: "sample 1",
      availableChannels: ["FSC-A", "FITC-A", "PE-A"],
    });
    expect(bd.compensations).toHaveLength(1);
    expect(bd.compensations[0]).toMatchObject({
      id: "fcs_spillover_sample_1",
      source: "fcs_keyword",
      sample: "sample 1",
      keyword: "$SPILLOVER",
      channels: ["FITC-A", "PE-A"],
      matrix: [[1, 0.2], [0.1, 1]],
    });

    const csv = extractSpilloverMatrices({
      keywords: { SPILL: "FITC-A,PE-A\n1,0.2\n0.1,1" },
      sampleId: "sample_001",
      availableChannels: ["FITC-A", "PE-A"],
    });
    expect(csv.compensations[0]?.id).toBe("fcs_spill_sample_001");
    expect(csv.compensations[0]?.matrix).toEqual([[1, 0.2], [0.1, 1]]);

    const indexed = extractSpilloverMatrices({
      keywords: { $SPILLOVER: "2,3,4,1,0.2,0.1,1" },
      sampleId: "sample_001",
      availableChannels: ["FSC-A", "SSC-A", "FL1-A", "FL2-A", "FL1-H", "FL2-H"],
    });
    expect(indexed.compensations[0]?.channels).toEqual(["FL1-A", "FL2-A"]);
  });

  it("aligns compensation to the channel intersection and leaves other columns pass-through", () => {
    const matrix: CompensationMatrix = {
      id: "fcs_spillover_sample_001",
      source: "fcs_keyword",
      sample: "sample_001",
      keyword: "$SPILLOVER",
      channels: ["FITC-A", "PE-A", "Missing-A"],
      matrix: [
        [1, 0.2, 0],
        [0.1, 1, 0],
        [0, 0, 1],
      ],
    };
    const aligned = alignCompensationMatrix(matrix, ["FSC-A", "FITC-A", "PE-A"]);
    expect(aligned.compensation.channels).toEqual(["FITC-A", "PE-A"]);
    expect(aligned.compensation.matrix).toEqual([[1, 0.2], [0.1, 1]]);
    expect(aligned.warnings).toEqual(["Matrix channel Missing-A did not match any available sample channel."]);

    const applied = applyCompensationColumns({
      channels: ["FSC-A", "FITC-A", "PE-A"],
      values: [[100, 12, 21]],
      compensation: aligned.compensation,
    });
    expect(applied.values[0]?.[0]).toBe(100);
    expect(applied.values[0]?.[1]).toBeCloseTo(10.1020408);
    expect(applied.values[0]?.[2]).toBeCloseTo(18.9795918);
    expect(applied.compensation).toMatchObject({
      applied: true,
      id: "fcs_spillover_sample_001",
      channels: ["FITC-A", "PE-A"],
    });

    const detectorAligned = alignCompensationMatrix({
      ...matrix,
      channels: ["FL03-A", "FL13-A"],
      matrix: [[1, 0.2], [0.1, 1]],
    }, [
      { name: "FITC-A", detector: "FL03-A" },
      { name: "PE (R-phycoerythrin)-A", detector: "FL13-A" },
    ]);
    expect(detectorAligned.compensation.channels).toEqual(["FITC-A", "PE (R-phycoerythrin)-A"]);
  });

  it("detects pre-compensated and spectral signals without auto-applying compensation", () => {
    const status = detectCompensationStatus({
      keywords: { $CYT: "Cytek Aurora" },
      channels: ["FJComp-FITC-A", "PE-A"],
      compensations: [{
        id: "fcs_spillover_sample_001",
        source: "fcs_keyword",
        sample: "sample_001",
        keyword: "$SPILLOVER",
        channels: ["FITC-A", "PE-A"],
        matrix: [[1, 0.2], [0.1, 1]],
      }],
    });
    expect(status.detectedAsPreCompensated).toBe(true);
    expect(status.embeddedMatrixFound).toBe(true);
    expect(status.suggestedCompensationId).toBeUndefined();
    expect(status.recommendation).toContain("may double-compensate");
  });

  it("initializes and validates a workspace", async () => {
    const { workspacePath } = await makeWorkspace();
    const workspace = await readWorkspace(workspacePath);
    expect(workspace.version).toBe(1);
    expect(workspace.revision).toBe(0);
    expect(workspace.samples[0]?.id).toBe("sample_001");
    expect(workspace.samples[0]?.path).toBe(path.join("data", "sample.fcs"));

    const validation = await validateWorkspace(workspacePath);
    expect(validation).toEqual({ ok: true, errors: [] });
  });

  it("reads metadata without requiring event data in the workspace", async () => {
    const { workspacePath } = await makeWorkspace();
    const metadata = await getSampleMetadata(workspacePath, "sample_001");
    expect(metadata.eventCount).toBeGreaterThan(0);
    expect(metadata.parameters.length).toBeGreaterThan(1);
    expect(metadata.parameters[0]?.name).toBeTruthy();
  });

  it("validates every installed real FCS fixture through metadata and preview reads", async () => {
    const manifest = await readFixtureManifest();
    for (const fixture of manifest.fixtures) {
      const sourcePath = path.resolve(fixture.path);
      await expect(fs.access(sourcePath), `${fixture.id} is missing; run npm run fixtures:fetch`).resolves.toBeUndefined();
      const { workspacePath } = await makeWorkspaceFromFixture(sourcePath, fixture.id);
      const validation = await validateWorkspace(workspacePath);
      expect(validation, fixture.id).toEqual({ ok: true, errors: [] });

      const metadata = await getSampleMetadata(workspacePath, fixture.id);
      expect(metadata.parameters.length, fixture.id).toBeGreaterThanOrEqual(fixture.expected?.minParameters ?? 2);
      if (fixture.expected?.minEvents !== undefined) {
        expect(metadata.eventCount ?? 0, fixture.id).toBeGreaterThanOrEqual(fixture.expected.minEvents);
      }
      for (const keyword of fixture.expected?.requiredKeywords ?? []) {
        expect(metadata.keywords, `${fixture.id} missing ${keyword}`).toHaveProperty(keyword);
      }

      const x = metadata.parameters[0]?.name;
      const y = metadata.parameters[1]?.name;
      expect(x, fixture.id).toBeTruthy();
      expect(y, fixture.id).toBeTruthy();

      const points = await getEventPreview({
        workspacePath,
        sampleId: fixture.id,
        x,
        y,
        maxEvents: 32,
      });
      expect(points.format, fixture.id).toBe("points");
      expect(points.sampledEvents, fixture.id).toBeLessThanOrEqual(32);
      expect(points.points?.length, fixture.id).toBe(points.sampledEvents);

      const bins = await getEventPreview({
        workspacePath,
        sampleId: fixture.id,
        x,
        y,
        maxEvents: 60000,
        format: "bins",
        binWidth: 32,
        binHeight: 24,
      });
      expect(bins.format, fixture.id).toBe("bins");
      expect(bins.bins?.counts, fixture.id).toHaveLength(32 * 24);
      expect(bins.bins?.counts.reduce((sum, count) => sum + count, 0), fixture.id).toBe(bins.sampledEvents);
    }
  });

  it("reads FCS data when vendor $ENDDATA is one past EOF but $TOT and row width match", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-off-by-one-fcs-"));
    const fcsPath = path.join(dir, "vendor-enddata-one-past-eof.fcs");
    const data = Buffer.alloc(8);
    data.writeUInt16LE(10, 0);
    data.writeUInt16LE(20, 2);
    data.writeUInt16LE(30, 4);
    data.writeUInt16LE(40, 6);
    const textSegment = (beginData: number, endData: number) => `|${[
      "$BEGINANALYSIS", "0",
      "$BEGINDATA", String(beginData).padStart(12, "0"),
      "$BYTEORD", "1,2,3,4",
      "$DATATYPE", "I",
      "$ENDANALYSIS", "0",
      "$ENDDATA", String(endData).padStart(12, "0"),
      "$MODE", "L",
      "$NEXTDATA", "0",
      "$PAR", "2",
      "$TOT", "2",
      "$P1B", "16",
      "$P1N", "FSC-A",
      "$P1R", "65535",
      "$P2B", "16",
      "$P2N", "SSC-A",
      "$P2R", "65535",
    ].join("|")}|`;

    const firstText = textSegment(0, 0);
    const textStart = 58;
    const textEnd = textStart + firstText.length - 1;
    const dataStart = textEnd + 1;
    const dataEndOnePastEof = dataStart + data.length;
    const text = textSegment(dataStart, dataEndOnePastEof);
    const header = `FCS3.1    ${String(textStart).padStart(8)}${String(textStart + text.length - 1).padStart(8)}${String(dataStart).padStart(8)}${String(dataEndOnePastEof).padStart(8)}${String(0).padStart(8)}${String(0).padStart(8)}`;
    expect(Buffer.byteLength(header, "ascii")).toBe(58);
    await fs.writeFile(fcsPath, Buffer.concat([Buffer.from(header, "ascii"), Buffer.from(text, "latin1"), data]));

    const columns = await readPreviewColumns({ path: fcsPath, x: "FSC-A", y: "SSC-A" });
    expect(Array.from(columns.x)).toEqual([10, 30]);
    expect(Array.from(columns.y)).toEqual([20, 40]);
    expect(columns.totalEvents).toBe(2);
  });

  it("stores embedded spillover metadata and applies compensation only when requested", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-comp-fcs-"));
    const fcsPath = path.join(dir, "comp_sample.fcs");
    await writeTinyIntegerFcs({
      fcsPath,
      channels: ["FSC-A", "SSC-A", "FITC-A", "PE-A"],
      rows: [
        [1, 2, 12, 21],
        [3, 4, 24, 42],
      ],
      extraKeywords: {
        $SPILLOVER: "2,FITC-A,PE-A,1,0.2,0.1,1",
      },
    });

    const opened = await openFcsArtifact({
      path: fcsPath,
      workspaceDir: dir,
      sampleId: "comp_sample",
    });
    expect(opened.compensationSummary).toEqual({
      available: true,
      count: 1,
      defaultApplied: false,
      suggestedCompensationId: "fcs_spillover_comp_sample",
    });
    expect(opened.revision).toBe(1);

    const workspace = await readWorkspace(opened.workspacePath);
    expect(workspace.compensations?.[0]).toMatchObject({
      id: "fcs_spillover_comp_sample",
      sample: "comp_sample",
      channels: ["FITC-A", "PE-A"],
      matrix: [[1, 0.2], [0.1, 1]],
    });
    expect(workspace.compensationStatus?.comp_sample?.suggestedCompensationId).toBe("fcs_spillover_comp_sample");

    const raw = await getEventPreview({
      workspacePath: opened.workspacePath,
      sampleId: "comp_sample",
      x: "FITC-A",
      y: "PE-A",
      maxEvents: 10,
    });
    expect(raw.compensation).toBeUndefined();
    expect(raw.points?.[0]).toEqual([12, 21]);

    const compensated = await getEventPreview({
      workspacePath: opened.workspacePath,
      sampleId: "comp_sample",
      x: "FITC-A",
      y: "PE-A",
      maxEvents: 10,
      compensationId: "fcs_spillover_comp_sample",
    });
    expect(compensated.compensation).toMatchObject({
      applied: true,
      id: "fcs_spillover_comp_sample",
      source: "fcs_keyword",
      channels: ["FITC-A", "PE-A"],
    });
    expect(compensated.points?.[0]?.[0]).toBeCloseTo(10.1020408);
    expect(compensated.points?.[0]?.[1]).toBeCloseTo(18.9795918);
  });

  it("aligns spillover fluorochrome labels through partial $PnS marker metadata", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-pns-comp-fcs-"));
    const fcsPath = path.join(dir, "pns_comp_sample.fcs");
    await writeTinyIntegerFcs({
      fcsPath,
      channels: ["FSC-A", "SSC-A", "FL1-A", "FL2-A"],
      markers: [undefined, undefined, "FITC", "PE"],
      rows: [
        [1, 2, 12, 21],
        [3, 4, 24, 42],
      ],
      extraKeywords: {
        $SPILLOVER: "2,FITC,PE,1,0.2,0.1,1",
      },
    });

    const opened = await openFcsArtifact({
      path: fcsPath,
      workspaceDir: dir,
      sampleId: "pns_comp_sample",
    });
    expect(opened.compensationSummary.suggestedCompensationId).toBe("fcs_spillover_pns_comp_sample");

    const metadata = await getSampleMetadata(opened.workspacePath, "pns_comp_sample");
    expect(metadata.parameters[2]).toMatchObject({ name: "FL1-A", marker: "FITC" });
    expect(metadata.parameters[3]).toMatchObject({ name: "FL2-A", marker: "PE" });

    const preview = await getEventPreview({
      workspacePath: opened.workspacePath,
      sampleId: "pns_comp_sample",
      x: "FL1-A",
      y: "FL2-A",
      maxEvents: 10,
      compensationId: "fcs_spillover_pns_comp_sample",
    });
    expect(preview.compensation).toMatchObject({
      applied: true,
      id: "fcs_spillover_pns_comp_sample",
      channels: ["FL1-A", "FL2-A"],
    });
    expect(preview.points?.[0]?.[0]).toBeCloseTo(10.1020408);
    expect(preview.points?.[0]?.[1]).toBeCloseTo(18.9795918);
  });

  it("returns a capped deterministic event preview", async () => {
    const { workspacePath } = await makeWorkspace();
    const metadata = await getSampleMetadata(workspacePath, "sample_001");
    const x = metadata.parameters[0]?.name;
    const y = metadata.parameters[1]?.name;
    expect(x).toBeTruthy();
    expect(y).toBeTruthy();

    const previewA = await getEventPreview({
      workspacePath,
      sampleId: "sample_001",
      x,
      y,
      maxEvents: 128,
    });
    const previewB = await getEventPreview({
      workspacePath,
      sampleId: "sample_001",
      x,
      y,
      maxEvents: 128,
    });
    expect(previewA.sampledEvents).toBeLessThanOrEqual(128);
    expect(previewA.format).toBe("points");
    expect(previewA.totalEvents).toBeGreaterThan(0);
    expect(previewA.points?.length).toBe(previewA.sampledEvents);
    expect(previewA.points?.slice(0, 10)).toEqual(previewB.points?.slice(0, 10));
  });

  it("filters previews through the selected parent gate ancestry", async () => {
    const { workspacePath } = await makeWorkspace();
    const metadata = await getSampleMetadata(workspacePath, "sample_001");
    const x = metadata.parameters[0]?.name;
    const y = metadata.parameters[1]?.name;
    expect(x).toBeTruthy();
    expect(y).toBeTruthy();
    const rootColumns = await readPreviewColumns({ path: fixturePath, x, y });
    const sortedX = Array.from(rootColumns.x).sort((a, b) => a - b);
    const min = sortedX[0];
    const median = sortedX[Math.floor(sortedX.length / 2)];
    expect(Number.isFinite(min)).toBe(true);
    expect(Number.isFinite(median)).toBe(true);

    await upsertGate({
      workspacePath,
      expectedRevision: 0,
      gate: {
        id: "parent_range",
        name: "Parent Range",
        sample: "sample_001",
        parent: "root",
        type: "range",
        x,
        min,
        max: median,
      },
    });

    const preview = await getEventPreview({
      workspacePath,
      sampleId: "sample_001",
      x,
      y,
      parent: "parent_range",
      maxEvents: 64,
    });
    const expectedFiltered = Array.from(rootColumns.x).filter((value) => value >= min && value <= median).length;
    expect(preview.totalEvents).toBe(rootColumns.totalEvents);
    expect(preview.filteredEvents).toBe(expectedFiltered);
    expect(preview.filteredEvents).toBeLessThan(preview.totalEvents);
    expect(preview.sampledEvents).toBeLessThanOrEqual(64);
    preview.points?.forEach(([value]) => {
      expect(value).toBeGreaterThanOrEqual(min);
      expect(value).toBeLessThanOrEqual(median);
    });
  });

  it("rejects an unknown preview parent gate instead of returning unfiltered events", async () => {
    const { workspacePath } = await makeWorkspace();
    const metadata = await getSampleMetadata(workspacePath, "sample_001");
    const x = metadata.parameters[0]?.name;
    const y = metadata.parameters[1]?.name;
    expect(x).toBeTruthy();
    expect(y).toBeTruthy();

    await expect(getEventPreview({
      workspacePath,
      sampleId: "sample_001",
      x,
      y,
      parent: "missing_parent",
      maxEvents: 64,
    })).rejects.toMatchObject({ code: "unknown_parent_gate" });
  });

  it("returns cached binned previews and rejects oversized raw point previews", async () => {
    const { dir, workspacePath } = await makeWorkspace();
    const metadata = await getSampleMetadata(workspacePath, "sample_001");
    const x = metadata.parameters[0]?.name;
    const y = metadata.parameters[1]?.name;
    expect(x).toBeTruthy();
    expect(y).toBeTruthy();

    const binned = await getEventPreview({
      workspacePath,
      sampleId: "sample_001",
      x,
      y,
      maxEvents: 60000,
      format: "bins",
      binWidth: 64,
      binHeight: 48,
    });
    expect(binned.format).toBe("bins");
    expect(binned.bins?.width).toBe(64);
    expect(binned.bins?.height).toBe(48);
    expect(binned.bins?.counts).toHaveLength(64 * 48);
    expect(binned.bins?.counts.reduce((sum, count) => sum + count, 0)).toBe(binned.sampledEvents);

    const cacheDir = path.join(dir, ".datalox", "cache", "previews");
    const cacheFiles = await fs.readdir(cacheDir);
    expect(cacheFiles.some((file) => file.endsWith(".json"))).toBe(true);
    expect(cacheFiles.some((file) => file.endsWith(".bin"))).toBe(true);

    const cached = await getEventPreview({
      workspacePath,
      sampleId: "sample_001",
      x,
      y,
      maxEvents: 60000,
      format: "bins",
      binWidth: 64,
      binHeight: 48,
    });
    expect(cached).toEqual(binned);

    await expect(getEventPreview({
      workspacePath,
      sampleId: "sample_001",
      x,
      y,
      maxEvents: 50001,
      format: "points",
    })).rejects.toMatchObject({ code: "point_preview_too_large" });
  });

  it("renders deterministic SVG plot images from the shared preview path", async () => {
    const { workspacePath } = await makeWorkspace();
    const first = await renderPlotImage({
      workspacePath,
      sampleId: "sample_001",
      x: "HDR-T",
      y: "FSC-A",
      format: "bins",
      binWidth: 32,
      binHeight: 24,
      width: 640,
      height: 420,
    });
    const second = await renderPlotImage({
      workspacePath,
      sampleId: "sample_001",
      x: "HDR-T",
      y: "FSC-A",
      format: "bins",
      binWidth: 32,
      binHeight: 24,
      width: 640,
      height: 420,
    });
    expect(first.image.mimeType).toBe("image/svg+xml");
    expect(first.image.svg).toBe(second.image.svg);
    expect(first.image.svg).toContain("<svg");
    expect(first.image.svg).toContain("HDR-T");
    expect(first.image.svg).toContain("FSC-A");
    expect(first.image.svg).toContain("<rect");
    expect(first.image.path).toBeTruthy();
    await expect(fs.access(first.image.path as string)).resolves.toBeUndefined();
    expect(second.image.path).toBe(first.image.path);

    await upsertGate({ workspacePath, gate: testGate("rendered_gate"), expectedRevision: 0 });
    const afterGate = await renderPlotImage({
      workspacePath,
      sampleId: "sample_001",
      x: "HDR-T",
      y: "FSC-A",
      format: "bins",
      binWidth: 32,
      binHeight: 24,
      width: 640,
      height: 420,
    });
    expect(afterGate.revision).toBe(1);
    expect(afterGate.image.svg).not.toBe(first.image.svg);
    expect(afterGate.image.path).not.toBe(first.image.path);
    expect(afterGate.image.svg).toContain("<polygon");

    await expect(renderPlotImage({
      workspacePath,
      sampleId: "sample_001",
      x: "HDR-T",
      y: "FSC-A",
      output: "file",
      outputPath: path.join(path.dirname(workspacePath), "..", "outside.svg"),
    })).rejects.toMatchObject({ code: "plot_output_path_outside_workspace" });
  });

  it("rejects unknown gate axes during validation", async () => {
    const { workspacePath } = await makeWorkspace();
    const workspace = await readWorkspace(workspacePath);
    workspace.gates.push({
      id: "bad_gate",
      sample: "sample_001",
      parent: "root",
      type: "polygon",
      x: "missing-x",
      y: "missing-y",
      vertices: [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
    });
    await fs.writeFile(workspacePath, `${JSON.stringify(workspace, null, 2)}\n`);
    const validation = await validateWorkspace(workspacePath);
    expect(validation.ok).toBe(false);
    expect(validation.errors.some((error) => error.code === "unknown_parameter")).toBe(true);
  });

  it("increments revision and rejects stale writes", async () => {
    const { workspacePath } = await makeWorkspace();
    const workspace = await readWorkspace(workspacePath);
    const writeResult = await writeWorkspace({ workspacePath, workspace, expectedRevision: 0 });
    expect(writeResult.ok).toBe(true);
    expect(writeResult.revision).toBe(1);

    const staleResult = await writeWorkspace({ workspacePath, workspace, expectedRevision: 0 });
    expect(staleResult.ok).toBe(false);
    expect(staleResult.errors[0]?.code).toBe("stale_revision");
  });

  it("creates, updates, deletes gates, and rejects stale gate writes", async () => {
    const { workspacePath } = await makeWorkspace();
    const createResult = await upsertGate({ workspacePath, gate: testGate(), expectedRevision: 0 });
    expect(createResult.ok).toBe(true);
    expect(createResult.revision).toBe(1);
    expect(createResult.gate?.id).toBe("gate_1");
    expect(createResult.gateCount).toBe(1);
    expect(createResult.workspacePath).toBe(workspacePath);
    expect((await readWorkspace(workspacePath)).gates).toHaveLength(1);

    const staleResult = await upsertGate({
      workspacePath,
      gate: { ...testGate(), name: "stale" },
      expectedRevision: 0,
    });
    expect(staleResult.ok).toBe(false);
    expect(staleResult.errors[0]?.path).toBe("/revision");
    expect(staleResult.errors[0]?.code).toBe("stale_revision");
    expect(staleResult.errors[0]?.details).toEqual({ currentRevision: 1, expectedRevision: 0 });

    const updateResult = await upsertGate({
      workspacePath,
      gate: { ...testGate(), name: "Updated Gate" },
      expectedRevision: 1,
    });
    expect(updateResult.ok).toBe(true);
    expect(updateResult.revision).toBe(2);
    expect(updateResult.gateCount).toBe(1);
    expect((await readWorkspace(workspacePath)).gates[0]?.name).toBe("Updated Gate");

    const deleteResult = await deleteGate({ workspacePath, gateId: "gate_1", expectedRevision: 2 });
    expect(deleteResult.ok).toBe(true);
    expect(deleteResult.revision).toBe(3);
    expect(deleteResult.gateCount).toBe(0);
    expect(deleteResult.workspacePath).toBe(workspacePath);
    expect((await readWorkspace(workspacePath)).gates).toEqual([]);
  });

  it("emits workspace file changes when revisions change", async () => {
    const { workspacePath } = await makeWorkspace();
    const revisions: number[] = [];
    const watcher = watchWorkspaceFile(workspacePath, (change) => {
      revisions.push(change.revision);
    });
    try {
      await upsertGate({ workspacePath, gate: testGate(), expectedRevision: 0 });
      const revision = await waitFor(() => revisions.find((value) => value === 1));
      expect(revision).toBe(1);
    } finally {
      watcher.close();
    }
  });

  it("reports workspace watcher read errors", async () => {
    const { workspacePath } = await makeWorkspace();
    const errors: unknown[] = [];
    const watcher = watchWorkspaceFile(
      workspacePath,
      () => undefined,
      (error) => {
        errors.push(error.error);
      },
    );
    try {
      await fs.writeFile(workspacePath, "{", "utf8");
      const error = await waitFor(() => errors[0]);
      expect(error).toBeTruthy();
    } finally {
      watcher.close();
    }
  });
});

describe("flowcyto CLI", () => {
  it("defines npx-ready package metadata", async () => {
    const packageJson = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8")) as {
      private?: boolean;
      engines?: { node?: string };
      publishConfig?: { access?: string; tag?: string; registry?: string };
      bin?: Record<string, string>;
      scripts?: Record<string, string>;
      files?: string[];
    };
    expect(packageJson.private).toBeUndefined();
    expect(packageJson.engines?.node).toBe(">=20");
    expect(packageJson.publishConfig?.access).toBe("public");
    expect(packageJson.publishConfig?.tag).toBe("alpha");
    expect(packageJson.publishConfig?.registry).toBe("https://registry.npmjs.org/");
    expect(packageJson.bin?.flowcyto).toBe("dist/src/cli/main.js");
    expect(packageJson.bin?.["flowcyto-mcp"]).toBe("dist/src/mcp/server.js");
    expect(packageJson.files).toContain("skills/flowcyto/SKILL.md");
    expect(packageJson.scripts?.prepack).toBe("npm run build");
    expect(packageJson.scripts?.["verify:publish"]).toContain("smoke:package");

    const sourceServer = await fs.readFile(path.resolve("src/mcp/server.ts"), "utf8");
    expect(sourceServer.startsWith("#!/usr/bin/env node\n")).toBe(true);
    const builtServer = await fs.readFile(path.resolve("dist/src/mcp/server.js"), "utf8");
    expect(builtServer.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("creates the live gating demo harness without gate writer scripts", async () => {
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-live-gating-demo-"));
    const { stdout } = await execFileAsync("node", [
      "scripts/create-live-gating-demo.mjs",
      "--target",
      targetDir,
      "--force",
    ], { cwd: path.resolve(".") });
    const result = JSON.parse(stdout) as {
      ok: boolean;
      targetDir: string;
      workspacePath: string;
      samplePath: string;
      mcpConfigPath: string;
      revision: number;
      gateCount: number;
    };
    expect(result.ok).toBe(true);
    expect(result.targetDir).toBe(targetDir);
    expect(result.revision).toBe(0);
    expect(result.gateCount).toBe(0);

    const entries = await fs.readdir(targetDir);
    expect(entries.sort()).toEqual([
      ".git",
      ".gitignore",
      ".mcp.json",
      "AGENTS.md",
      "README.md",
      "data",
      "flowcyto.workspace.json",
    ]);
    await expect(fs.access(result.samplePath)).resolves.toBeUndefined();

    const workspace = await readWorkspace(result.workspacePath);
    expect(workspace.revision).toBe(0);
    expect(workspace.gates).toEqual([]);
    expect(workspace.samples[0]?.path).toBe("data/sample_001.fcs");
    const validation = await validateWorkspace(result.workspacePath);
    expect(validation.ok).toBe(true);

    const mcpConfig = JSON.parse(await fs.readFile(result.mcpConfigPath, "utf8")) as {
      mcpServers?: { flowcyto?: { command?: string; args?: string[] } };
    };
    expect(mcpConfig.mcpServers?.flowcyto?.command).toBe("node");
    expect(mcpConfig.mcpServers?.flowcyto?.args?.[0]).toContain("dist/src/mcp/server.js");

    const agents = await fs.readFile(path.join(targetDir, "AGENTS.md"), "utf8");
    expect(agents).toContain("Use the Flowcyto MCP server registered in `.mcp.json`");
    expect(agents).toContain("Follow the");
    expect(agents).toContain("`nextAction` fields returned by Flowcyto tools");
    expect(agents).not.toContain("Required tool sequence");
    expect(agents).not.toContain("Do not use Computer Use");
    expect(agents).not.toContain("Allowed tools for the demo turn");
    expect(agents).not.toContain("datalox_agent_live_gate");
  });

  it("creates a no-AGENTS live gating demo harness", async () => {
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-live-gating-no-agents-"));
    const { stdout } = await execFileAsync("node", [
      "scripts/create-live-gating-demo.mjs",
      "--target",
      targetDir,
      "--force",
      "--no-agents",
    ], { cwd: path.resolve(".") });
    const result = JSON.parse(stdout) as {
      ok: boolean;
      targetDir: string;
      workspacePath: string;
      agentsPath: string | null;
    };
    expect(result.ok).toBe(true);
    expect(result.targetDir).toBe(targetDir);
    expect(result.agentsPath).toBeNull();

    const entries = await fs.readdir(targetDir);
    expect(entries.sort()).toEqual([
      ".git",
      ".gitignore",
      ".mcp.json",
      "README.md",
      "data",
      "flowcyto.workspace.json",
    ]);
    await expect(fs.access(path.join(targetDir, "AGENTS.md"))).rejects.toThrow();
    await expect(fs.access(path.join(targetDir, "scripts"))).rejects.toThrow();
    await expect(fs.access(path.join(targetDir, "prompts"))).rejects.toThrow();

    const readme = await fs.readFile(path.join(targetDir, "README.md"), "utf8");
    expect(readme).toContain("Disposable Flowcyto data repo");
    expect(readme).not.toContain("Expected Tool Trace");
    expect(readme).not.toContain("The agent must use");

    await upsertGate({
      workspacePath: result.workspacePath,
      expectedRevision: 0,
      gate: {
        id: "agent_main_population_gate",
        name: "Agent Main Population Gate",
        sample: "sample_001",
        parent: "root",
        type: "polygon",
        x: "FSC-A",
        y: "SSC-A",
        vertices: [
          [-600, 250],
          [650, 250],
          [650, 4400],
          [-350, 4400],
          [-700, 900],
        ],
      },
    });

    const validation = await execFileAsync("node", [
      "scripts/validate-live-demo-result.mjs",
      "--workspace",
      result.workspacePath,
      "--allow-no-agents",
    ], { cwd: path.resolve(".") });
    const body = JSON.parse(validation.stdout) as { ok: boolean; agentsAbsent: boolean };
    expect(body.ok).toBe(true);
    expect(body.agentsAbsent).toBe(true);
  });

  it("validates the live demo result artifact", async () => {
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-live-gating-result-"));
    const { stdout } = await execFileAsync("node", [
      "scripts/create-live-gating-demo.mjs",
      "--target",
      targetDir,
      "--force",
    ], { cwd: path.resolve(".") });
    const result = JSON.parse(stdout) as { workspacePath: string };

    await expect(execFileAsync("node", [
      "scripts/validate-live-demo-result.mjs",
      "--workspace",
      result.workspacePath,
    ], { cwd: path.resolve(".") })).rejects.toThrow();

    await upsertGate({
      workspacePath: result.workspacePath,
      expectedRevision: 0,
      gate: {
        id: "agent_main_population_gate",
        name: "Agent Main Population Gate",
        sample: "sample_001",
        parent: "root",
        type: "polygon",
        x: "FSC-A",
        y: "SSC-A",
        vertices: [
          [-600, 250],
          [650, 250],
          [650, 4400],
          [-350, 4400],
          [-700, 900],
        ],
      },
    });

    const validation = await execFileAsync("node", [
      "scripts/validate-live-demo-result.mjs",
      "--workspace",
      result.workspacePath,
    ], { cwd: path.resolve(".") });
    const body = JSON.parse(validation.stdout) as { ok: boolean; revision: number; gateCount: number; gateType: string };
    expect(body.ok).toBe(true);
    expect(body.revision).toBe(1);
    expect(body.gateCount).toBe(1);
    expect(body.gateType).toBe("polygon");
  });

  it("runs validate, metadata, and preview against a fixture workspace", async () => {
    const { workspacePath } = await makeWorkspace();
    const cliPath = path.resolve("dist/src/cli/main.js");

    const validate = await execFileAsync("node", [cliPath, "validate", workspacePath]);
    expect(JSON.parse(validate.stdout).ok).toBe(true);

    const metadata = await execFileAsync("node", [cliPath, "metadata", workspacePath, "--sample", "sample_001"]);
    const parsedMetadata = JSON.parse(metadata.stdout);
    const x = parsedMetadata.metadata.parameters[0].name;
    const y = parsedMetadata.metadata.parameters[1].name;
    expect(parsedMetadata.ok).toBe(true);

    const preview = await execFileAsync("node", [
      cliPath,
      "preview",
      workspacePath,
      "--sample",
      "sample_001",
      "--x",
      x,
      "--y",
      y,
      "--max-events",
      "32",
    ]);
    const parsedPreview = JSON.parse(preview.stdout);
    expect(parsedPreview.ok).toBe(true);
    expect(parsedPreview.preview.sampledEvents).toBeLessThanOrEqual(32);

    const openDir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-open-fcs-cli-"));
    const opened = await execFileAsync("node", [
      cliPath,
      "open-fcs",
      fixturePath,
      "--workspace-dir",
      openDir,
    ]);
    const parsedOpened = JSON.parse(opened.stdout) as {
      ok: boolean;
      workspacePath: string;
      sampleId: string;
      channels: Array<{ name: string }>;
      gateEditorPolicy: { compactGateEditorRequired: boolean; openCommand: string };
      nextAction: { command: string; required: boolean; arguments: { sample_id: string; x: string; y: string } };
    };
    expect(parsedOpened.ok).toBe(true);
    expect(parsedOpened.workspacePath).toBe(path.join(openDir, "flowcyto.workspace.json"));
    expect(parsedOpened.sampleId).toBe("CFP_Well_A4");
    expect(parsedOpened.channels.some((channel) => channel.name === "FSC-A")).toBe(true);
    expect(parsedOpened.gateEditorPolicy).toMatchObject({
      compactGateEditorRequired: true,
      openCommand: "flowcyto open-gate-editor-window",
    });
    expect(parsedOpened.nextAction.command).toBe("flowcyto open-gate-editor-window");
    expect(parsedOpened.nextAction.required).toBe(true);
    expect(parsedOpened.nextAction.arguments).toMatchObject({ sample_id: "CFP_Well_A4", x: "FSC-A", y: "SSC-A" });
  });

  it("reports alpha install readiness through doctor", async () => {
    const cliPath = path.resolve("dist/src/cli/main.js");
    const result = await execFileAsync("node", [cliPath, "doctor"]);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean }>;
      commands: { cli: string; mcp: string; nativePreview: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.checks.find((check) => check.name === "flowcyto_bin")?.ok).toBe(true);
    expect(parsed.checks.find((check) => check.name === "flowcyto_mcp_bin")?.ok).toBe(true);
    expect(parsed.commands.mcp).toBe("flowcyto-mcp");
  });

  it("starts the gate editor server and prints its URL", async () => {
    const { workspacePath } = await makeWorkspace();
    const cliPath = path.resolve("dist/src/cli/main.js");
    const child = spawn("node", [cliPath, "open-gate-editor", workspacePath, "--port", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    try {
      const started = await new Promise<{ url: string; mcpAppPreviewUrl: string; port: number }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("CLI gate editor did not start.")), 3000);
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
          if (!stdout.trimEnd().endsWith("}")) return;
          clearTimeout(timer);
          resolve(JSON.parse(stdout) as { url: string; mcpAppPreviewUrl: string; port: number });
        });
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code !== null && code !== 0) reject(new Error(`CLI exited before test completed with ${code}.`));
        });
      });
      expect(started.port).toBeGreaterThan(0);
      expect(started.mcpAppPreviewUrl).toBe(`${started.url}mcp-app-preview`);
      const response = await fetch(`${started.url}api/workspace`);
      const body = await response.json() as { ok: boolean; workspace: FlowcytoWorkspace };
      expect(body.ok).toBe(true);
      expect(body.workspace.revision).toBe(0);
    } finally {
      child.kill();
    }
  });
});

describe("flowcyto gate editor server", () => {
  it("defines native preview platform contracts", async () => {
    const script = macGateEditorWindowScript();
    expect(supportsNativeGateEditorWindow()).toBe(process.platform === "darwin" || process.platform === "win32");
    expect(supportsNativeGateEditorWindow("darwin")).toBe(true);
    expect(supportsNativeGateEditorWindow("win32")).toBe(true);
    expect(supportsNativeGateEditorWindow("linux")).toBe(false);
    expect(nativeGateEditorRuntimeForPlatform("darwin")).toBe("macos_wkwebview");
    expect(nativeGateEditorRuntimeForPlatform("win32")).toBe("windows_webview2");
    expect(nativeGateEditorRuntimeForPlatform("linux")).toBeNull();
    expect(script).toContain("WKWebView");
    expect(script).toContain("flowcyto_native_window_ready");
    expect(script).toContain("NSURLRequest.requestWithURL");
    expect(script).toContain("windowWillClose");

    expect(isLocalGateEditorPreviewUrl("http://127.0.0.1:50514/mcp-app-preview")).toBe(true);
    expect(isLocalGateEditorPreviewUrl("http://localhost:50514/mcp-app-preview")).toBe(true);
    expect(isLocalGateEditorPreviewUrl("https://127.0.0.1:50514/mcp-app-preview")).toBe(false);
    expect(isLocalGateEditorPreviewUrl("http://0.0.0.0:50514/mcp-app-preview")).toBe(false);
    expect(isLocalGateEditorPreviewUrl("http://127.0.0.1:50514/")).toBe(false);

    expect(windowsWebView2HelperPath("x64", "/pkg")).toBe(path.join("/pkg", "dist", "native", "windows", "win-x64", "flowcyto-webview2-window.exe"));
    expect(windowsWebView2HelperPath("arm64", "/pkg")).toBe(path.join("/pkg", "dist", "native", "windows", "win-arm64", "flowcyto-webview2-window.exe"));
    expect(windowsWebView2LoaderPath("x64", "/pkg")).toBe(path.join("/pkg", "dist", "native", "windows", "win-x64", "WebView2Loader.dll"));
    expect(windowsWebView2LoaderPath("arm64", "/pkg")).toBe(path.join("/pkg", "dist", "native", "windows", "win-arm64", "WebView2Loader.dll"));

    const packageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-native-readiness-"));
    const missingReadiness = nativeGateEditorReadiness("win32", "x64", packageRoot);
    expect(missingReadiness.ok).toBe(false);
    expect(missingReadiness.detail).toBe("windows_webview2_helper_missing");

    const helperPath = windowsWebView2HelperPath("x64", packageRoot);
    const loaderPath = windowsWebView2LoaderPath("x64", packageRoot);
    await fs.mkdir(path.dirname(helperPath), { recursive: true });
    await fs.writeFile(helperPath, "");
    const missingLoaderReadiness = nativeGateEditorReadiness("win32", "x64", packageRoot);
    expect(missingLoaderReadiness.ok).toBe(false);
    expect(missingLoaderReadiness.detail).toBe("windows_webview2_loader_missing");
    await fs.writeFile(loaderPath, "");
    const readyReadiness = nativeGateEditorReadiness("win32", "x64", packageRoot);
    expect(readyReadiness.ok).toBe(true);
    expect(readyReadiness.detail).toBe("windows_webview2");

    const unsupportedError = nativeGateEditorReadinessError(nativeGateEditorReadiness("linux"));
    expect(unsupportedError?.code).toBe("native_window_unsupported");
    expect(unsupportedError?.path).toBe("/surface");

    const missingHelperError = nativeGateEditorReadinessError(missingReadiness);
    expect(missingHelperError?.code).toBe("windows_webview2_helper_missing");
    expect(missingHelperError?.path).toBe("/surface/runtime");
    const missingLoaderError = nativeGateEditorReadinessError(missingLoaderReadiness);
    expect(missingLoaderError?.code).toBe("windows_webview2_loader_missing");
    expect(missingLoaderError?.path).toBe("/surface/runtime");
  });

  it("builds native window launcher plans without opening browser chrome", async () => {
    const url = "http://127.0.0.1:50514/mcp-app-preview";
    const macPlan = nativeGateEditorLaunchPlan({
      url,
      title: "Mac Flowcyto",
      width: 610,
      height: 640,
    }, "darwin");
    expect(macPlan.runtime).toBe("macos_wkwebview");
    expect(macPlan.runtimeLabel).toBe("WebKit");
    expect(macPlan.command).toBe("osascript");
    expect(macPlan.args[0]).toBe("-l");
    expect(macPlan.args[1]).toBe("JavaScript");
    expect(macPlan.args[2]).toBe("-e");
    expect(macPlan.args[3]).toContain("WKWebView");
    expect(macPlan.args.slice(4)).toEqual([url, "Mac Flowcyto", "610", "640"]);
    expect(macPlan.args).not.toContain("open");

    const packageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-webview2-plan-"));
    const helperPath = windowsWebView2HelperPath("x64", packageRoot);
    const loaderPath = windowsWebView2LoaderPath("x64", packageRoot);
    await fs.mkdir(path.dirname(helperPath), { recursive: true });
    await fs.writeFile(helperPath, "");
    await fs.writeFile(loaderPath, "");
    const windowsPlan = nativeGateEditorLaunchPlan({
      url,
      title: "Windows Flowcyto",
    }, "win32", "x64", packageRoot);
    expect(windowsPlan.runtime).toBe("windows_webview2");
    expect(windowsPlan.runtimeLabel).toBe("WebView2");
    expect(windowsPlan.command).toBe(helperPath);
    expect(windowsPlan.args).toEqual([url, "Windows Flowcyto", "620", "620"]);
    expect(windowsPlan.windowsHide).toBe(true);

    expect(() => nativeGateEditorLaunchPlan({ url }, "linux")).toThrow(FlowcytoError);
    try {
      nativeGateEditorLaunchPlan({ url }, "linux");
      throw new Error("Expected unsupported native window platform to throw.");
    } catch (error) {
      expect(error).toBeInstanceOf(FlowcytoError);
      expect((error as FlowcytoError).code).toBe("native_window_unsupported");
      expect((error as FlowcytoError).path).toBe("/surface");
    }

    try {
      nativeGateEditorLaunchPlan({ url: "https://example.com/mcp-app-preview" }, "darwin");
      throw new Error("Expected public native preview URL to throw.");
    } catch (error) {
      expect(error).toBeInstanceOf(FlowcytoError);
      expect((error as FlowcytoError).code).toBe("native_window_url_not_local");
      expect((error as FlowcytoError).path).toBe("/surface/url");
    }
  });

  it("defines the Windows WebView2 helper source contract", async () => {
    const helperRoot = path.resolve("native/windows/FlowcytoGateEditorWindow");
    const project = await fs.readFile(path.join(helperRoot, "FlowcytoGateEditorWindow.csproj"), "utf8");
    const program = await fs.readFile(path.join(helperRoot, "Program.cs"), "utf8");
    const mainForm = await fs.readFile(path.join(helperRoot, "MainForm.cs"), "utf8");

    expect(project).toContain("<OutputType>Exe</OutputType>");
    expect(project).toContain("<TargetFramework>net8.0-windows</TargetFramework>");
    expect(project).toContain("<PackageReference Include=\"Microsoft.Web.WebView2\" Version=\"1.0.3537.50\" />");

    expect(program).toContain("flowcyto_native_window_ready");
    expect(program).toContain("flowcyto_native_window_error");
    expect(program).toContain("native_window_url_not_local");
    expect(program).toContain("\"/mcp-app-preview\"");
    expect(program).toContain("http://127.0.0.1:<port>/mcp-app-preview");

    expect(mainForm).toContain("CoreWebView2Environment.GetAvailableBrowserVersionString()");
    expect(mainForm).toContain("WebView2RuntimeNotFoundException");
    expect(mainForm).toContain("webview2_runtime_missing");
    expect(mainForm).toContain("Environment.SpecialFolder.LocalApplicationData");
    expect(mainForm).toContain("AreDefaultContextMenusEnabled = false");
    expect(mainForm).toContain("Program.IsAllowedPreviewUri(uri)");
  });

  it("parses structured native window errors for agent-readable CLI output", () => {
    expect(parseNativeWindowErrorPayload(JSON.stringify({
      code: "webview2_runtime_missing",
      path: "/surface/runtime",
      message: "Microsoft Edge WebView2 Runtime is required.",
    }))).toEqual({
      code: "webview2_runtime_missing",
      path: "/surface/runtime",
      message: "Microsoft Edge WebView2 Runtime is required.",
    });

    expect(parseNativeWindowErrorPayload("plain native failure")).toEqual({
      code: "native_window_failed",
      path: "/surface",
      message: "plain native failure",
    });
  });

  it("serves the plot panel and revision-safe gate endpoints", async () => {
    const { workspacePath } = await makeWorkspace();
    const server = await startGateEditorServer({ workspacePath, port: 0, maxEvents: 64 });
    try {
      const html = await fetch(server.url);
      expect(await html.text()).toContain("<canvas id=\"plot\"");
      const previewHtml = await fetch(server.mcpAppPreviewUrl);
      const previewText = await previewHtml.text();
      expect(previewText).toContain("window.__flowcytoMcpAppPreview = true");
      expect(previewText).toContain("window.openai");
      expect(previewText).toContain("callTool(name");
      expect(previewText).toContain("get_plot_context");

      const stateResponse = await fetch(`${server.url}api/state`);
      const stateBody = await stateResponse.json() as { ok: boolean; workspace: FlowcytoWorkspace; preview: { sampledEvents: number } };
      expect(stateBody.ok).toBe(true);
      expect(stateBody.workspace.revision).toBe(0);
      expect(stateBody.preview.sampledEvents).toBeLessThanOrEqual(64);

      const healthResponse = await fetch(`${server.url}api/health`);
      const healthBody = await healthResponse.json() as {
        ok: boolean;
        revision: number;
        sampleCount: number;
        gateCount: number;
        validation: { ok: boolean };
      };
      expect(healthBody.ok).toBe(true);
      expect(healthBody.revision).toBe(0);
      expect(healthBody.sampleCount).toBe(1);
      expect(healthBody.gateCount).toBe(0);
      expect(healthBody.validation.ok).toBe(true);

      const createResponse = await fetch(`${server.url}api/gates/upsert`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gate: testGate(), expectedRevision: 0 }),
      });
      const createBody = await createResponse.json() as { ok: boolean; revision: number };
      expect(createBody.ok).toBe(true);
      expect(createBody.revision).toBe(1);

      const staleResponse = await fetch(`${server.url}api/gates/upsert`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gate: { ...testGate(), name: "stale" }, expectedRevision: 0 }),
      });
      const staleBody = await staleResponse.json() as { ok: boolean; errors: Array<{ code: string }> };
      expect(staleResponse.status).toBe(409);
      expect(staleBody.ok).toBe(false);
      expect(staleBody.errors[0]?.code).toBe("stale_revision");

      const updateResponse = await fetch(`${server.url}api/gates/upsert`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gate: { ...testGate(), name: "Updated Gate" }, expectedRevision: 1 }),
      });
      const updateBody = await updateResponse.json() as { ok: boolean; revision: number };
      expect(updateBody.ok).toBe(true);
      expect(updateBody.revision).toBe(2);

      const deleteResponse = await fetch(`${server.url}api/gates/delete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gateId: "gate_1", expectedRevision: 2 }),
      });
      const deleteBody = await deleteResponse.json() as { ok: boolean; revision: number };
      expect(deleteBody.ok).toBe(true);
      expect(deleteBody.revision).toBe(3);
      expect((await readWorkspace(workspacePath)).gates).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("previews the embedded MCP app branch with a local callTool shim", async () => {
    const { workspacePath } = await makeWorkspace();
    const server = await startGateEditorServer({ workspacePath, port: 0, maxEvents: 256 });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 900, height: 680 } });
    try {
      await page.goto(server.mcpAppPreviewUrl);
      await page.locator("#plot").waitFor();
      await expect.poll(() => page.locator("#status").textContent()).toContain("Ready revision 0");
      const branch = await page.evaluate(() => ({
        preview: Boolean((window as typeof window & { __flowcytoMcpAppPreview?: boolean }).__flowcytoMcpAppPreview),
        callTool: typeof (window as typeof window & { openai?: { callTool?: unknown } }).openai?.callTool,
      }));
      expect(branch).toEqual({ preview: true, callTool: "function" });

      await page.locator("#rectMode").click();
      const box = await page.locator("#plot").boundingBox();
      if (!box) throw new Error("Plot canvas has no bounding box.");
      await page.mouse.move(box.x + 210, box.y + 180);
      await page.mouse.down();
      await page.mouse.move(box.x + 410, box.y + 320);
      await page.mouse.up();
      await page.locator("#gateName").fill("Embedded Preview Gate");
      await page.locator("#saveGate").click();
      await expect.poll(() => readWorkspace(workspacePath).then((workspace) => workspace.revision)).toBe(1);
      const workspace = await readWorkspace(workspacePath);
      expect(workspace.gates[0]?.name).toBe("Embedded Preview Gate");

      await upsertGate({
        workspacePath,
        expectedRevision: 1,
        gate: {
          id: "agent_embedded_gate",
          name: "Agent Embedded Gate",
          sample: "sample_001",
          parent: "root",
          type: "rect",
          x: "HDR-T",
          y: "FSC-A",
          xMin: 0,
          xMax: 50,
          yMin: 0,
          yMax: 50,
        },
      });
      await expect.poll(() => page.locator("#status").textContent(), { timeout: 4000 }).toContain("Workspace revision 2");
      await page.locator("#gateTrayToggle").click();
      await expect.poll(() => page.locator("#gateList").textContent()).toContain("Agent Embedded Gate");
    } finally {
      await page.close();
      await browser.close();
      await server.close();
    }
  }, 15_000);

  it("returns typed health errors for malformed workspace artifacts", async () => {
    const { workspacePath } = await makeWorkspace();
    const server = await startGateEditorServer({ workspacePath, port: 0, maxEvents: 64 });
    try {
      await fs.writeFile(workspacePath, "{", "utf8");
      const response = await fetch(`${server.url}api/health`);
      const body = await response.json() as {
        ok: boolean;
        errors: Array<{ code: string; path: string }>;
      };
      expect(response.status).toBe(200);
      expect(body.ok).toBe(false);
      expect(body.errors[0]?.path).toBe("/");
      expect(body.errors[0]?.code).toBe("invalid_workspace_json");
    } finally {
      await server.close();
    }
  });

  it("supports browser drawing, parent-aware gates, pan/zoom, and live external updates", async () => {
    const { workspacePath } = await makeWorkspace();
    const server = await startGateEditorServer({ workspacePath, port: 0, maxEvents: 512 });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1024, height: 720 } });
    try {
      await page.goto(server.url);
      await page.locator("#plot").waitFor();
      await expect.poll(() => page.locator("#status").textContent()).toContain("Ready revision 0");
      expect(await page.locator("#renderMode").inputValue()).toBe("pseudocolor");
      expect(await page.locator("#xScale").inputValue()).toBe("linear");
      const compactLayout = await page.evaluate(() => {
        const plotFrame = document.querySelector(".plot-frame")?.getBoundingClientRect();
        const xSelect = document.querySelector("#xSelect")?.getBoundingClientRect();
        const ySelect = document.querySelector("#ySelect")?.getBoundingClientRect();
        const selectMode = document.querySelector("#selectMode")?.getBoundingClientRect();
        const gateTray = document.querySelector("#gateTray");
        if (!plotFrame || !xSelect || !ySelect || !selectMode || !gateTray) {
          return null;
        }
        return {
          plotWidth: plotFrame.width,
          plotHeight: plotFrame.height,
          xSelectTop: xSelect.top,
          xSelectLeft: xSelect.left,
          xSelectRight: xSelect.right,
          ySelectRight: ySelect.right,
          plotTop: plotFrame.top,
          plotLeft: plotFrame.left,
          plotRight: plotFrame.right,
          plotBottom: plotFrame.bottom,
          toolButtonWidth: selectMode.width,
          gateTrayHidden: gateTray.hasAttribute("hidden"),
        };
      });
      if (!compactLayout) throw new Error("Compact layout elements were not present.");
      expect(Math.abs(compactLayout.plotWidth - compactLayout.plotHeight)).toBeLessThan(2);
      expect(compactLayout.plotWidth).toBeGreaterThan(360);
      expect(compactLayout.xSelectTop).toBeGreaterThanOrEqual(compactLayout.plotBottom);
      expect(compactLayout.xSelectLeft).toBeLessThan(compactLayout.plotRight);
      expect(compactLayout.xSelectRight).toBeGreaterThan(compactLayout.plotLeft);
      expect(compactLayout.ySelectRight).toBeLessThanOrEqual(compactLayout.plotLeft + 8);
      expect(compactLayout.toolButtonWidth).toBeLessThanOrEqual(30);
      expect(compactLayout.gateTrayHidden).toBe(true);
      await page.locator("#gateTrayToggle").click();
      expect(await page.locator("#gateTray").evaluate((element) => element.hasAttribute("hidden"))).toBe(false);
      await page.locator("#closeGateTray").click();
      expect(await page.locator("#gateTray").evaluate((element) => element.hasAttribute("hidden"))).toBe(true);
      const canvasStats = async (): Promise<{ coloredPixels: number; chromaticPixels: number; colorBuckets: number; hash: number }> => page.locator("#plot").evaluate((canvas: HTMLCanvasElement) => {
        const context = canvas.getContext("2d");
        if (!context) return { coloredPixels: 0, chromaticPixels: 0, colorBuckets: 0, hash: 0 };
        const image = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const buckets = new Set<string>();
        let coloredPixels = 0;
        let chromaticPixels = 0;
        let hash = 0;
        for (let index = 0; index < image.length; index += 4) {
          const red = image[index] ?? 0;
          const green = image[index + 1] ?? 0;
          const blue = image[index + 2] ?? 0;
          if (red < 246 || green < 246 || blue < 246) {
            coloredPixels += 1;
            buckets.add(`${Math.floor(red / 32)}:${Math.floor(green / 32)}:${Math.floor(blue / 32)}`);
            if (Math.abs(red - green) > 10 || Math.abs(green - blue) > 10 || Math.abs(red - blue) > 10) chromaticPixels += 1;
          }
          if (index % 64 === 0) hash = ((hash * 31) + red + (green * 3) + (blue * 7)) >>> 0;
        }
        return { coloredPixels, chromaticPixels, colorBuckets: buckets.size, hash };
      });
      const defaultStats = await canvasStats();
      expect(defaultStats.coloredPixels).toBeGreaterThan(20);
      expect(defaultStats.chromaticPixels).toBeGreaterThan(20);
      expect(defaultStats.colorBuckets).toBeGreaterThan(3);

      await page.locator("#renderMode").selectOption("density");
      const densityStats = await canvasStats();
      expect(densityStats.coloredPixels).toBeGreaterThan(20);
      await page.locator("#renderMode").selectOption("pseudocolor");
      await page.locator("#xScale").selectOption("arcsinh");
      await page.locator("#yScale").selectOption("arcsinh");
      await expect.poll(() => page.locator("#plot").getAttribute("aria-label")).toContain("arcsinh");
      expect(await readWorkspace(workspacePath).then((workspace) => workspace.revision)).toBe(0);
      const scaledStats = await canvasStats();
      expect(scaledStats.hash).not.toBe(defaultStats.hash);
      await page.locator("#xScale").selectOption("log");
      await page.locator("#yScale").selectOption("log");
      await expect.poll(() => page.locator("#plot").getAttribute("aria-label")).toContain("log");
      await page.locator("#xScale").selectOption("biex");
      await page.locator("#yScale").selectOption("biex");
      await expect.poll(() => page.locator("#plot").getAttribute("aria-label")).toContain("biex");
      await page.locator("#xScale").selectOption("linear");
      await page.locator("#yScale").selectOption("linear");
      await page.locator("#xSelect").selectOption("HDR-T");
      await page.locator("#ySelect").selectOption("FSC-A");
      await expect.poll(() => page.locator("#plot").getAttribute("aria-label")).toContain("HDR-T");

      await page.locator("#rectMode").click();
      const box = await page.locator("#plot").boundingBox();
      if (!box) throw new Error("Plot canvas has no bounding box.");
      await page.mouse.click(box.x + 20, box.y + 20);
      await page.locator("#saveGate").click();
      await expect.poll(() => readWorkspace(workspacePath).then((workspace) => workspace.revision)).toBe(0);
      await page.mouse.move(box.x + 220, box.y + 180);
      await page.mouse.down();
      await page.mouse.move(box.x + 420, box.y + 340);
      await page.mouse.up();
      await page.locator("#gateName").fill("Root Gate");
      await page.locator("#saveGate").click();
      await expect.poll(() => readWorkspace(workspacePath).then((workspace) => workspace.revision)).toBe(1);
      const rootWorkspace = await readWorkspace(workspacePath);
      const rootGate = rootWorkspace.gates[0];
      await expect.poll(() => page.locator("#gateTray").evaluate((element) => element.hasAttribute("hidden"))).toBe(false);
      await page.locator("#closeGateTray").click();
      expect(await page.locator("#gateTray").evaluate((element) => element.hasAttribute("hidden"))).toBe(true);
      expect(rootGate?.parent).toBe("root");
      expect(rootGate?.name).toBe("Root Gate");
      expect(rootGate?.type).toBe("rect");
      if (rootGate?.type !== "rect") throw new Error("Root gate should be a rect gate.");
      expect(Number.isFinite(rootGate.xMin)).toBe(true);
      expect(Number.isFinite(rootGate.xMax)).toBe(true);
      expect(rootGate.xMax).toBeGreaterThan(rootGate.xMin);

      await page.locator("#parentSelect").selectOption(rootGate.id);
      await expect.poll(() => page.locator("#status").textContent()).toContain("Ready revision 1");
      await page.locator("#rectMode").click();
      await page.mouse.move(box.x + 260, box.y + 220);
      await page.mouse.down();
      await page.mouse.move(box.x + 460, box.y + 360);
      await page.mouse.up();
      await page.locator("#gateName").fill("Child Gate");
      await page.locator("#saveGate").click();
      await expect.poll(() => readWorkspace(workspacePath).then((workspace) => workspace.revision)).toBe(2);
      await expect.poll(() => page.locator("#status").textContent()).toContain("revision 2");
      const childWorkspace = await readWorkspace(workspacePath);
      expect(childWorkspace.gates).toHaveLength(2);
      expect(childWorkspace.gates[1]?.parent).toBe(rootGate.id);
      const parentOptions = await page.locator("#parentSelect option").evaluateAll((options) =>
        options.map((option) => ({ value: (option as HTMLOptionElement).value, label: option.textContent || "" })),
      );
      expect(parentOptions.find((option) => option.value === rootGate.id)?.label).toBe("\u00a0\u00a0\u00a0Root Gate");
      expect(parentOptions.find((option) => option.value === childWorkspace.gates[1]?.id)?.label).toContain("\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0Child Gate");
      await expect.poll(() => page.locator("#populationStats").textContent()).toContain("events");
      await expect.poll(() => page.locator("#gateTray").evaluate((element) => element.hasAttribute("hidden"))).toBe(false);

      await upsertGate({
        workspacePath,
        expectedRevision: 2,
        gate: {
          id: "root_fsc_ssc_gate",
          name: "Root FSC SSC Gate",
          sample: "sample_001",
          parent: "root",
          type: "rect",
          x: "FSC-A",
          y: "SSC-A",
          xMin: 0,
          xMax: 50,
          yMin: 0,
          yMax: 50,
        },
      });
      await expect.poll(() => page.locator("#status").textContent()).toContain("Workspace revision 3");
      await page.locator("#parentSelect").selectOption("root");
      await expect.poll(() => page.locator("#xSelect").inputValue()).toBe("FSC-A");
      expect(await page.locator("#ySelect").inputValue()).toBe("SSC-A");
      await page.getByRole("button", { name: /^> Root Gate rect$/ }).click();
      await expect.poll(() => page.locator("#parentSelect").inputValue()).toBe(rootGate.id);
      await expect.poll(() => page.locator("#xSelect").inputValue()).toBe("HDR-T");
      expect(await page.locator("#ySelect").inputValue()).toBe("FSC-A");

      await page.locator("#resetView").click();
      await page.mouse.wheel(0, -250);
      await page.locator("#selectMode").click();
      await page.mouse.move(box.x + 320, box.y + 260);
      await page.mouse.down();
      await page.mouse.move(box.x + 350, box.y + 280);
      await page.mouse.up();

      await page.locator("#parentSelect").selectOption("root");
      await upsertGate({
        workspacePath,
        expectedRevision: 3,
        gate: {
          id: "agent_gate",
          name: "<img src=x onerror=alert(1)>Agent Gate",
          sample: "sample_001",
          parent: "root",
          type: "rect",
          x: "HDR-T",
          y: "FSC-A",
          xMin: 0,
          xMax: 50,
          yMin: 0,
          yMax: 50,
        },
      });
      await expect.poll(() => page.locator("#status").textContent()).toContain("Workspace revision 4");
      await expect.poll(() => page.locator("#gateList").textContent()).toContain("<img src=x onerror=alert(1)>Agent Gate");
      await expect.poll(() => page.locator("#gateList img").count()).toBe(0);
    } finally {
      await page.close();
      await browser.close();
      await server.close();
    }
  }, 15000);

  it("streams workspace change and error events over SSE", async () => {
    const { workspacePath } = await makeWorkspace();
    const server = await startGateEditorServer({ workspacePath, port: 0, maxEvents: 64 });
    const response = await fetch(`${server.url}api/events`);
    const events = makeSseReader(response);
    try {
      expect(response.status).toBe(200);
      await upsertGate({ workspacePath, gate: testGate(), expectedRevision: 0 });
      const changed = await events.nextEvent("workspace_changed") as {
        revision: number;
        workspace: FlowcytoWorkspace;
      };
      expect(changed.revision).toBe(1);
      expect(changed.workspace.gates[0]?.id).toBe("gate_1");

      await fs.writeFile(workspacePath, "{", "utf8");
      const error = await events.nextEvent("workspace_error") as {
        ok: boolean;
        errors: Array<{ code: string; path: string }>;
      };
      expect(error.ok).toBe(false);
      expect(error.errors[0]?.path).toBe("/");
      expect(error.errors[0]?.code).toBe("invalid_workspace_json");
    } finally {
      await events.cancel();
      await server.close();
    }
  });
});

describe("flowcyto MCP", () => {
  it("serves the same tools over Streamable HTTP for real MCP host registration", async () => {
    const { workspacePath } = await makeWorkspace();
    const serverPath = path.resolve("dist/src/mcp/server.js");
    const child = spawn("node", [serverPath, "--http", "--host", "127.0.0.1", "--port", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const client = new Client({ name: "flowcyto-streamable-http-test", version: "0.0.0" });

    try {
      const started = await waitForJsonStdout<{
        ok: boolean;
        transport: string;
        url: string;
        port: number;
      }>(child);
      expect(started.ok).toBe(true);
      expect(started.transport).toBe("streamable_http");
      expect(started.port).toBeGreaterThan(0);

      const health = await fetch(`http://127.0.0.1:${started.port}/`);
      const healthBody = await health.json() as { ok: boolean; mcpPath: string };
      expect(healthBody.ok).toBe(true);
      expect(healthBody.mcpPath).toBe("/mcp");

      const transport = new StreamableHTTPClientTransport(new URL(started.url));
      await client.connect(transport);
      expect(transport.sessionId).toBeTruthy();

      const tools = await client.listTools();
      expect(tools.tools.some((tool) => tool.name === "open_fcs")).toBe(true);
      expect(tools.tools.some((tool) => tool.name === "render_plot")).toBe(true);
      expect(tools.tools.some((tool) => tool.name === "list_compensations")).toBe(true);
      expect(tools.tools.some((tool) => tool.name === "get_compensation_matrix")).toBe(true);
      expect(tools.tools.some((tool) => tool.name === "open_gate_editor")).toBe(true);
      expect(tools.tools.some((tool) => tool.name === "get_plot_context")).toBe(true);
      expect(tools.tools.some((tool) => tool.name === "render_gate_editor")).toBe(true);
      expect(tools.tools.some((tool) => tool.name === "get_workspace_revision")).toBe(true);

      const resource = await client.readResource({ uri: "ui://flowcyto/gate-editor-v1.html" });
      expect(resource.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");

      const metadata = await client.callTool({
        name: "get_sample_metadata",
        arguments: { workspace_path: workspacePath, sample_id: "sample_001" },
      });
      const metadataResult = (metadata.structuredContent as { result?: unknown } | undefined)?.result as {
        eventCount: number;
        parameters: Array<{ name: string }>;
      };
      expect(metadataResult.eventCount).toBeGreaterThan(0);

      const preview = await client.callTool({
        name: "get_event_preview",
        arguments: {
          workspace_path: workspacePath,
          sample_id: "sample_001",
          x: metadataResult.parameters[0]?.name,
          y: metadataResult.parameters[1]?.name,
          max_events: 16,
        },
      });
      const previewResult = (preview.structuredContent as { result?: unknown } | undefined)?.result as {
        sampledEvents: number;
      };
      expect(previewResult.sampledEvents).toBeLessThanOrEqual(16);

      const context = await client.callTool({
        name: "get_plot_context",
        arguments: {
          workspace_path: workspacePath,
          sample_id: "sample_001",
          x: metadataResult.parameters[0]?.name,
          y: metadataResult.parameters[1]?.name,
          max_events: 16,
        },
      });
      const contextResult = (context.structuredContent as { result?: unknown } | undefined)?.result as {
        ok: boolean;
        revision: number;
        bounds: { xMin: number; xMax: number; yMin: number; yMax: number };
        gateSchema: { requiredRevisionField: string };
      };
      expect(contextResult.ok).toBe(true);
      expect(contextResult.revision).toBe(0);
      expect(contextResult.bounds.xMax).toBeGreaterThan(contextResult.bounds.xMin);
      expect(contextResult.bounds.yMax).toBeGreaterThan(contextResult.bounds.yMin);
      expect(contextResult.gateSchema.requiredRevisionField).toBe("expected_revision");

      const created = await client.callTool({
        name: "upsert_gate",
        arguments: { workspace_path: workspacePath, gate: testGate("http_gate"), expected_revision: 0 },
      });
      const createdResult = (created.structuredContent as { result?: unknown } | undefined)?.result as {
        ok: boolean;
        revision: number;
        gateCount: number;
        workspacePath: string;
      };
      expect(createdResult.ok).toBe(true);
      expect(createdResult.revision).toBe(1);
      expect(createdResult.gateCount).toBe(1);
      expect(createdResult.workspacePath).toBe(workspacePath);
    } finally {
      await client.close().catch(() => undefined);
      await stopChild(child);
    }
  });

  it("renders the MCP app resource against an SDK-backed host bridge", async () => {
    const { workspacePath } = await makeWorkspace();
    const serverPath = path.resolve("dist/src/mcp/server.js");
    const client = new Client({ name: "flowcyto-app-host-test", version: "0.0.0" });
    const transport = new StdioClientTransport({ command: "node", args: [serverPath] });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 900, height: 680 } });
    const toolCalls: string[] = [];

    try {
      await client.connect(transport);
      const rendered = await client.callTool({
        name: "open_gate_editor",
        arguments: { workspace_path: workspacePath, surface: "mcp_app", sample_id: "sample_001", max_events: 64 },
      });
      const toolOutput = (rendered.structuredContent as { result?: unknown } | undefined)?.result as {
        ok: boolean;
        workspacePath: string;
      };
      expect(toolOutput.ok).toBe(true);

      const resource = await client.readResource({ uri: "ui://flowcyto/gate-editor-v1.html" });
      const html = "text" in resource.contents[0] ? resource.contents[0].text as string : "";
      expect(html).toContain("window.openai.callTool");

      await page.exposeFunction("flowcytoCallTool", async (name: string, args: Record<string, unknown>) => {
        toolCalls.push(name);
        const result = await client.callTool({ name, arguments: args ?? {} });
        return JSON.parse(JSON.stringify(result)) as unknown;
      });
      const hostInjectedHtml = html.replace("<body>", `<body><script>
        window.openai = {
          toolOutput: ${JSON.stringify(toolOutput).replace(/</g, "\\u003c")},
          async callTool(name, args = {}) {
            return window.flowcytoCallTool(name, args);
          }
        };
      </script>`);
      await page.setContent(hostInjectedHtml, { waitUntil: "domcontentloaded" });
      await page.locator("#plot").waitFor();
      await expect.poll(() => page.locator("#status").textContent()).toContain("Ready revision 0");

      const branch = await page.evaluate(() => ({
        preview: Boolean((window as typeof window & { __flowcytoMcpAppPreview?: boolean }).__flowcytoMcpAppPreview),
        callTool: typeof (window as typeof window & { openai?: { callTool?: unknown } }).openai?.callTool,
      }));
      expect(branch).toEqual({ preview: false, callTool: "function" });
      expect(toolCalls).toContain("get_plot_context");
      expect(toolCalls).not.toContain("get_gate_editor_state");
      const initialPlotContextCalls = toolCalls.filter((name) => name === "get_plot_context").length;

      await page.locator("#rectMode").click();
      const box = await page.locator("#plot").boundingBox();
      if (!box) throw new Error("Plot canvas has no bounding box.");
      await page.mouse.move(box.x + 210, box.y + 180);
      await page.mouse.down();
      await page.mouse.move(box.x + 410, box.y + 320);
      await page.mouse.up();
      expect(await readWorkspace(workspacePath).then((workspace) => workspace.revision)).toBe(0);
      await page.locator("#gateName").fill("SDK Host Gate");
      await page.locator("#saveGate").click();
      await expect.poll(() => readWorkspace(workspacePath).then((workspace) => workspace.revision)).toBe(1);
      await page.evaluate(() => {
        (window as typeof window & { __flowcytoNoReloadMarker?: boolean }).__flowcytoNoReloadMarker = true;
      });

      const external = await client.callTool({
        name: "upsert_gate",
        arguments: {
          workspace_path: workspacePath,
          expected_revision: 1,
          gate: {
            id: "sdk_host_agent_gate",
            name: "SDK Host Agent Gate",
            sample: "sample_001",
            parent: "root",
            type: "rect",
            x: "HDR-T",
            y: "FSC-A",
            xMin: 0,
            xMax: 50,
            yMin: 0,
            yMax: 50,
          },
        },
      });
      const externalResult = (external.structuredContent as { result?: unknown } | undefined)?.result as {
        ok: boolean;
        revision: number;
        gateCount: number;
        workspacePath: string;
      };
      expect(externalResult.ok).toBe(true);
      expect(externalResult.revision).toBe(2);
      expect(externalResult.gateCount).toBe(2);
      expect(externalResult.workspacePath).toBe(workspacePath);
      await expect.poll(() => page.locator("#status").textContent(), { timeout: 1500 }).toContain("Workspace revision 2");
      expect(await page.evaluate(() => (window as typeof window & { __flowcytoNoReloadMarker?: boolean }).__flowcytoNoReloadMarker)).toBe(true);
      expect(toolCalls.filter((name) => name === "get_workspace_revision").length).toBeGreaterThan(0);
      expect(toolCalls.filter((name) => name === "get_plot_context").length).toBeGreaterThan(initialPlotContextCalls);
      await page.locator("#gateTrayToggle").click();
      await expect.poll(() => page.locator("#gateList").textContent()).toContain("SDK Host Agent Gate");
    } finally {
      await page.close();
      await browser.close();
      await client.close();
    }
  });

  it("exposes the full agent workflow through MCP descriptors and nextAction results", async () => {
    const { workspacePath } = await makeWorkspace();
    const serverPath = path.resolve("dist/src/mcp/server.js");
    const client = new Client({ name: "flowcyto-agent-contract-test", version: "0.0.0" });
    const transport = new StdioClientTransport({ command: "node", args: [serverPath] });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const openTool = tools.tools.find((tool) => tool.name === "open_gate_editor");
      const contextTool = tools.tools.find((tool) => tool.name === "get_plot_context");
      const upsertTool = tools.tools.find((tool) => tool.name === "upsert_gate");
      expect(openTool?.description).toContain("get_plot_context");
      expect(openTool?.description).toContain("surface=\"native_window\"");
      expect(contextTool?.description).toContain("upsert_gate");
      expect(contextTool?.description).toContain("do not read FCS files");
      expect(upsertTool?.description).toContain("get_workspace_revision");
      expect((openTool?._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri).toBe("ui://flowcyto/gate-editor-v1.html");

      const opened = await client.callTool({
        name: "open_gate_editor",
        arguments: { workspace_path: workspacePath, surface: "mcp_app" },
      });
      const openedResult = (opened.structuredContent as { result?: unknown } | undefined)?.result as {
        ok: boolean;
        agentContract: { version: number; forbiddenActions: string[] };
        nextAction: { tool: string; arguments: Record<string, unknown> };
      };
      expect(openedResult.ok).toBe(true);
      expect(openedResult.agentContract.version).toBe(1);
      expect(openedResult.agentContract.forbiddenActions).toContain("do_not_write_workspace_json_directly");
      expect(openedResult.agentContract.forbiddenActions).toContain("do_not_use_local_python_or_plotting_for_gate_geometry");
      expect(openedResult.nextAction.tool).toBe("get_plot_context");
      expect(openedResult.nextAction.arguments.workspace_path).toBe(workspacePath);
      expect(openedResult.nextAction.arguments.sample_id).toBe("sample_001");
      expect(openedResult.nextAction.arguments.x).toBeTruthy();
      expect(openedResult.nextAction.arguments.y).toBeTruthy();
      expect(openedResult.nextAction.arguments.format).toBe("bins");

      const context = await client.callTool({
        name: openedResult.nextAction.tool,
        arguments: openedResult.nextAction.arguments,
      });
      const contextResult = (context.structuredContent as { result?: unknown } | undefined)?.result as {
        ok: boolean;
        expected_revision: number;
        bounds: { xMin: number; xMax: number; yMin: number; yMax: number };
        recommendedGate: {
          type: string;
          writeTool: string;
          geometrySource: string;
          geometryInstructions: string[];
          requiredFields: string[];
          gateTemplate: Record<string, unknown>;
        };
        nextAction: { tool: string; arguments: { workspace_path: string; expected_revision: number; gateTemplate: Record<string, unknown> } };
      };
      expect(contextResult.ok).toBe(true);
      expect(contextResult.expected_revision).toBe(0);
      expect(contextResult.recommendedGate.type).toBe("polygon");
      expect(contextResult.recommendedGate.writeTool).toBe("upsert_gate");
      expect(contextResult.recommendedGate.geometrySource).toBe("preview_or_bins_from_get_plot_context");
      expect(contextResult.recommendedGate.geometryInstructions.join(" ")).toContain("Do not read the FCS file directly");
      expect(contextResult.recommendedGate.requiredFields).toContain("vertices");
      expect(contextResult.nextAction.tool).toBe("upsert_gate");
      expect(contextResult.nextAction.arguments.workspace_path).toBe(workspacePath);
      expect(contextResult.nextAction.arguments.expected_revision).toBe(contextResult.expected_revision);
      expect(contextResult.nextAction.arguments.gateTemplate.type).toBe("polygon");

      const gate = {
        ...contextResult.nextAction.arguments.gateTemplate,
        vertices: [
          [contextResult.bounds.xMin, contextResult.bounds.yMin],
          [contextResult.bounds.xMax, contextResult.bounds.yMin],
          [contextResult.bounds.xMax, contextResult.bounds.yMax],
          [contextResult.bounds.xMin, contextResult.bounds.yMax],
        ],
      };
      const created = await client.callTool({
        name: contextResult.nextAction.tool,
        arguments: {
          workspace_path: contextResult.nextAction.arguments.workspace_path,
          expected_revision: contextResult.nextAction.arguments.expected_revision,
          gate,
        },
      });
      const createdResult = (created.structuredContent as { result?: unknown } | undefined)?.result as {
        ok: boolean;
        revision: number;
        gateCount: number;
        nextAction: { tool: string; arguments: { workspace_path: string } };
      };
      expect(createdResult.ok).toBe(true);
      expect(createdResult.revision).toBe(1);
      expect(createdResult.gateCount).toBe(1);
      expect(createdResult.nextAction.tool).toBe("get_workspace_revision");
      expect(createdResult.nextAction.arguments.workspace_path).toBe(workspacePath);
    } finally {
      await client.close();
    }
  });

  it("exposes self-discovery for opening FCS files, rendering plots, and writing gates", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-open-fcs-mcp-"));
    const serverPath = path.resolve("dist/src/mcp/server.js");
    const client = new Client({ name: "flowcyto-self-discovery-test", version: "0.0.0" });
    const transport = new StdioClientTransport({ command: "node", args: [serverPath] });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const openFcsTool = tools.tools.find((tool) => tool.name === "open_fcs");
      const renderPlotTool = tools.tools.find((tool) => tool.name === "render_plot");
      const renderPlotImageTool = tools.tools.find((tool) => tool.name === "render_plot_image");
      const openGateEditorTool = tools.tools.find((tool) => tool.name === "open_gate_editor");
      const upsertGateTool = tools.tools.find((tool) => tool.name === "upsert_gate");
      expect(openFcsTool?.description).toContain(".fcs");
      expect(openFcsTool?.description).toContain("workspace");
      expect(openFcsTool?.description).toContain("render");
      expect(openFcsTool?.description).toContain("gate");
      expect(renderPlotTool?.description).toContain("FSC/SSC");
      expect(renderPlotTool?.description).toContain("marker");
      expect(renderPlotTool?.description).toContain("render");
      expect(renderPlotTool?.description).toContain("plot");
      expect(renderPlotImageTool?.description).toContain("inline");
      expect(renderPlotImageTool?.description).toContain("same preview");
      expect(openGateEditorTool?.description).toContain("open_fcs");
      expect(upsertGateTool?.description).toContain("expected_revision from render_plot or get_plot_context");

      const resources = await client.listResources();
      expect(resources.resources.some((resource) => resource.uri === "flowcyto://capabilities")).toBe(true);
      expect(resources.resources.some((resource) => resource.uri === "flowcyto://workflow/open-fcs-and-gate")).toBe(true);
      const capabilities = await client.readResource({ uri: "flowcyto://capabilities" });
      const capabilitiesResult = JSON.parse("text" in capabilities.contents[0] ? capabilities.contents[0].text as string : "{}") as {
        supportsFileTypes: string[];
        canRenderPlots: boolean;
        canRenderPlotImages: boolean;
        canWriteStructuredGates: boolean;
        canonicalArtifact: string;
        compactGateEditor: {
          entryTool: string;
          requiredFor: string[];
          defaultSurfaceForAgentHosts: string;
          surfaceForMcpAppsHosts: string;
        };
      };
      expect(capabilitiesResult.supportsFileTypes).toContain(".fcs");
      expect(capabilitiesResult.canRenderPlots).toBe(true);
      expect(capabilitiesResult.canRenderPlotImages).toBe(true);
      expect(capabilitiesResult.canWriteStructuredGates).toBe(true);
      expect(capabilitiesResult.canonicalArtifact).toBe("flowcyto.workspace.json");
      expect(capabilitiesResult.compactGateEditor).toMatchObject({
        entryTool: "open_gate_editor",
        defaultSurfaceForAgentHosts: "native_window",
        surfaceForMcpAppsHosts: "mcp_app",
      });
      expect(capabilitiesResult.compactGateEditor.requiredFor).toEqual(["gate", "draw", "edit", "inspect_population"]);

      const prompts = await client.listPrompts();
      expect(prompts.prompts.some((prompt) => prompt.name === "open-fcs-and-gate-main-population")).toBe(true);
      expect(prompts.prompts.some((prompt) => prompt.name === "render-fcs-plot")).toBe(true);
      expect(prompts.prompts.some((prompt) => prompt.name === "review-workspace-gates")).toBe(true);
      const prompt = await client.getPrompt({
        name: "open-fcs-and-gate-main-population",
        arguments: { path: "sample.fcs" },
      });
      const promptText = "text" in prompt.messages[0].content ? prompt.messages[0].content.text : "";
      expect(promptText).toContain("open_fcs");
      expect(promptText).toContain("open_gate_editor");
      expect(promptText).toContain("Follow open_fcs result.nextAction immediately");
      expect(promptText).toContain("Do not stop after open_fcs");
      expect(promptText).toContain("upsert_gate");
      expect(promptText).toContain("AGENTS.md is optional convenience guidance");

      const skill = await fs.readFile(path.resolve("skills/flowcyto/SKILL.md"), "utf8");
      expect(skill).toContain("Prefer Flowcyto MCP tools");
      expect(skill).toContain("npx -y -p @datalox/flowcyto-mcp@alpha flowcyto open-fcs sample.fcs");
      expect(skill).toContain("Do not stop after `open_fcs`");
      expect(skill).toContain("Do not patch `flowcyto.workspace.json` directly");
      expect(skill).toContain("AGENTS.md");
      expect(skill).toContain("optional convenience guidance");

      const openedDefault = await client.callTool({
        name: "open_fcs",
        arguments: {
          path: fixturePath,
          workspace_dir: workspaceDir,
        },
      });
      const openedDefaultResult = (openedDefault.structuredContent as { result?: unknown } | undefined)?.result as {
        ok: boolean;
        gateEditorPolicy: {
          compactGateEditorRequired: boolean;
          defaultSurfaceForAgentHosts: string;
          surfaceForMcpAppsHosts: string;
          requiredFor: string[];
        };
        nextAction: { tool: string; required: boolean; reason: string; arguments: Record<string, unknown> };
      };
      expect(openedDefaultResult.ok).toBe(true);
      expect(openedDefaultResult.gateEditorPolicy).toMatchObject({
        compactGateEditorRequired: true,
        defaultSurfaceForAgentHosts: "native_window",
        surfaceForMcpAppsHosts: "mcp_app",
      });
      expect(openedDefaultResult.gateEditorPolicy.requiredFor).toContain("gate");
      expect(openedDefaultResult.nextAction.tool).toBe("open_gate_editor");
      expect(openedDefaultResult.nextAction.required).toBe(true);
      expect(openedDefaultResult.nextAction.reason).toContain("compact gate editor");
      expect(openedDefaultResult.nextAction.arguments.surface).toBe("native_window");

      const opened = await client.callTool({
        name: "open_fcs",
        arguments: {
          path: fixturePath,
          workspace_dir: workspaceDir,
          surface: "none",
        },
      });
      const openedResult = (opened.structuredContent as { result?: unknown } | undefined)?.result as {
        ok: boolean;
        workspacePath: string;
        sampleId: string;
        sourcePath: string;
        channels: Array<{ name: string }>;
        recommendedViews: Array<{ x: string; y: string; intent: string }>;
        gateEditorPolicy: { compactGateEditorRequired: boolean; requestedSurface: string };
        nextAction: { tool: string; required: boolean; arguments: Record<string, unknown> };
      };
      expect(openedResult.ok).toBe(true);
      expect(openedResult.workspacePath).toBe(path.join(workspaceDir, "flowcyto.workspace.json"));
      expect(openedResult.sampleId).toBe("CFP_Well_A4");
      expect(openedResult.sourcePath).toBe(fixturePath);
      expect(openedResult.channels.length).toBeGreaterThan(2);
      expect(openedResult.recommendedViews[0]).toMatchObject({ x: "FSC-A", y: "SSC-A", intent: "main_population" });
      expect(openedResult.gateEditorPolicy).toMatchObject({ compactGateEditorRequired: false, requestedSurface: "none" });
      expect(openedResult.nextAction.tool).toBe("render_plot");
      expect(openedResult.nextAction.required).toBe(false);

      const plot = await client.callTool({
        name: openedResult.nextAction.tool,
        arguments: openedResult.nextAction.arguments,
      });
      const plotResult = (plot.structuredContent as { result?: unknown } | undefined)?.result as {
        ok: boolean;
        revision: number;
        sampleId: string;
        x: string;
        y: string;
        bounds: { xMin: number; xMax: number; yMin: number; yMax: number };
        preview: { format: "points" | "bins"; sampledEvents: number };
        recommendedGate: { type: string; geometrySource: string };
        expected_revision: number;
        nextAction: { tool: string; arguments: { workspace_path: string; expected_revision: number; gateTemplate: Record<string, unknown> } };
      };
      expect(plotResult.ok).toBe(true);
      expect(plotResult.revision).toBe(0);
      expect(plotResult.sampleId).toBe(openedResult.sampleId);
      expect(plotResult.x).toBe("FSC-A");
      expect(plotResult.y).toBe("SSC-A");
      expect(plotResult.bounds.xMax).toBeGreaterThan(plotResult.bounds.xMin);
      expect(plotResult.bounds.yMax).toBeGreaterThan(plotResult.bounds.yMin);
      expect(plotResult.preview.format).toBe("bins");
      expect(plotResult.preview.sampledEvents).toBeGreaterThan(0);
      expect(plotResult.recommendedGate.type).toBe("polygon");
      expect(plotResult.recommendedGate.geometrySource).toBe("preview_or_bins_from_render_plot");
      expect(plotResult.nextAction.tool).toBe("upsert_gate");

      const gate = {
        ...plotResult.nextAction.arguments.gateTemplate,
        vertices: [
          [plotResult.bounds.xMin, plotResult.bounds.yMin],
          [plotResult.bounds.xMax, plotResult.bounds.yMin],
          [plotResult.bounds.xMax, plotResult.bounds.yMax],
          [plotResult.bounds.xMin, plotResult.bounds.yMax],
        ],
      };
      const created = await client.callTool({
        name: plotResult.nextAction.tool,
        arguments: {
          workspace_path: plotResult.nextAction.arguments.workspace_path,
          expected_revision: plotResult.nextAction.arguments.expected_revision,
          gate,
        },
      });
      const createdResult = (created.structuredContent as { result?: unknown } | undefined)?.result as {
        ok: boolean;
        revision: number;
        gateCount: number;
      };
      expect(createdResult.ok).toBe(true);
      expect(createdResult.revision).toBe(1);
      expect(createdResult.gateCount).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("exposes conventional compensation discovery and explicit compensated rendering over MCP", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-mcp-comp-"));
    const fcsPath = path.join(dir, "comp_sample.fcs");
    await writeTinyIntegerFcs({
      fcsPath,
      channels: ["FSC-A", "SSC-A", "FITC-A", "PE-A"],
      rows: [
        [1, 2, 12, 21],
        [3, 4, 24, 42],
      ],
      extraKeywords: {
        $SPILLOVER: "2,FITC-A,PE-A,1,0.2,0.1,1",
      },
    });

    const serverPath = path.resolve("dist/src/mcp/server.js");
    const client = new Client({ name: "flowcyto-comp-test-client", version: "0.0.0" });
    const transport = new StdioClientTransport({ command: "node", args: [serverPath] });

    try {
      await client.connect(transport);
      const opened = await client.callTool({
        name: "open_fcs",
        arguments: {
          path: fcsPath,
          workspace_dir: dir,
          sample_id: "comp_sample",
          surface: "none",
        },
      });
      const openedResult = (opened.structuredContent as { result?: unknown } | undefined)?.result as {
        ok: boolean;
        workspacePath: string;
        compensationSummary: { available: boolean; count: number; defaultApplied: boolean; suggestedCompensationId?: string };
        nextAction: { arguments: Record<string, unknown> };
      };
      expect(openedResult.ok).toBe(true);
      expect(openedResult.compensationSummary).toMatchObject({
        available: true,
        count: 1,
        defaultApplied: false,
        suggestedCompensationId: "fcs_spillover_comp_sample",
      });
      expect(openedResult.nextAction.arguments.compensation_id).toBeUndefined();

      const listed = await client.callTool({
        name: "list_compensations",
        arguments: {
          workspace_path: openedResult.workspacePath,
          sample_id: "comp_sample",
        },
      });
      const listedResult = (listed.structuredContent as { result?: unknown } | undefined)?.result as {
        ok: boolean;
        count: number;
        compensations: Array<{ id: string; channels: string[]; size: number }>;
      };
      expect(listedResult.ok).toBe(true);
      expect(listedResult.count).toBe(1);
      expect(listedResult.compensations[0]).toMatchObject({
        id: "fcs_spillover_comp_sample",
        channels: ["FITC-A", "PE-A"],
        size: 2,
      });

      const matrix = await client.callTool({
        name: "get_compensation_matrix",
        arguments: {
          workspace_path: openedResult.workspacePath,
          compensation_id: "fcs_spillover_comp_sample",
        },
      });
      const matrixResult = (matrix.structuredContent as { result?: unknown } | undefined)?.result as {
        ok: boolean;
        compensation: CompensationMatrix;
        orientation: string;
      };
      expect(matrixResult.ok).toBe(true);
      expect(matrixResult.compensation.matrix).toEqual([[1, 0.2], [0.1, 1]]);
      expect(matrixResult.orientation).toContain("solve(S.T, Xraw.T).T");

      const compensatedPlot = await client.callTool({
        name: "render_plot",
        arguments: {
          workspace_path: openedResult.workspacePath,
          sample_id: "comp_sample",
          x: "FITC-A",
          y: "PE-A",
          max_events: 10,
          compensation_id: "fcs_spillover_comp_sample",
        },
      });
      const compensatedPlotResult = (compensatedPlot.structuredContent as { result?: unknown } | undefined)?.result as {
        ok: boolean;
        preview: { compensation?: { applied: boolean; id?: string }; points?: Array<[number, number]> };
      };
      expect(compensatedPlotResult.ok).toBe(true);
      expect(compensatedPlotResult.preview.compensation).toMatchObject({
        applied: true,
        id: "fcs_spillover_comp_sample",
      });
      expect(compensatedPlotResult.preview.points?.[0]?.[0]).toBeCloseTo(10.1020408);

      const unknown = await client.callTool({
        name: "get_compensation_matrix",
        arguments: {
          workspace_path: openedResult.workspacePath,
          compensation_id: "missing_comp",
        },
      });
      const unknownResult = (unknown.structuredContent as { result?: unknown } | undefined)?.result as {
        ok: boolean;
        errors: Array<{ path: string; code: string }>;
      };
      expect(unknown.isError).toBe(true);
      expect(unknownResult.ok).toBe(false);
      expect(unknownResult.errors[0]).toMatchObject({ path: "/compensation_id", code: "unknown_compensation" });
    } finally {
      await client.close();
    }
  });

  it("exposes metadata and preview tools over stdio", async () => {
    const { workspacePath } = await makeWorkspace();
    const serverPath = path.resolve("dist/src/mcp/server.js");
    const client = new Client({ name: "flowcyto-test-client", version: "0.0.0" });
    const transport = new StdioClientTransport({ command: "node", args: [serverPath] });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "close_gate_editor",
        "delete_gate",
        "get_compensation_matrix",
        "get_event_preview",
        "get_gate_editor_state",
        "get_plot_context",
        "get_sample_metadata",
        "get_workspace_revision",
        "list_compensations",
        "list_samples",
        "open_fcs",
        "open_gate_editor",
        "open_workspace",
        "probe_inline_image",
        "read_workspace",
        "render_gate_editor",
        "render_plot",
        "render_plot_image",
        "upsert_gate",
        "validate_workspace",
        "write_workspace",
      ]);
      const openTool = tools.tools.find((tool) => tool.name === "open_gate_editor") as {
        _meta?: Record<string, unknown>;
      } | undefined;
      expect(openTool?._meta?.["openai/outputTemplate"]).toBe("ui://flowcyto/gate-editor-v1.html");
      expect((openTool?._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri).toBe("ui://flowcyto/gate-editor-v1.html");
      for (const name of ["get_plot_context", "get_workspace_revision", "upsert_gate", "delete_gate"]) {
        const tool = tools.tools.find((entry) => entry.name === name) as { _meta?: Record<string, unknown> } | undefined;
        expect(tool?._meta?.["openai/widgetAccessible"], name).toBe(true);
      }
      const renderTool = tools.tools.find((tool) => tool.name === "render_gate_editor");
      expect(renderTool?.description).toContain("Deprecated alias");
      const stateTool = tools.tools.find((tool) => tool.name === "get_gate_editor_state");
      expect(stateTool?.description).toContain("Deprecated alias");

      const resources = await client.listResources();
      expect(resources.resources.some((resource) =>
        resource.uri === "ui://flowcyto/gate-editor-v1.html"
        && resource.mimeType === "text/html;profile=mcp-app",
      )).toBe(true);
      const resource = await client.readResource({ uri: "ui://flowcyto/gate-editor-v1.html" });
      expect(resource.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
      const resourceHtml = "text" in resource.contents[0] ? resource.contents[0].text : "";
      expect(resourceHtml).toContain("window.openai.callTool");
      expect(resourceHtml).toContain("value !== undefined");
      expect(resourceHtml).toContain("<canvas id=\"plot\"");

      const metadata = await client.callTool({
        name: "get_sample_metadata",
        arguments: { workspace_path: workspacePath, sample_id: "sample_001" },
      });
      const metadataResult = (metadata.structuredContent as { result?: unknown } | undefined)?.result as {
        eventCount: number;
        parameters: Array<{ name: string }>;
      };
      expect(metadataResult.eventCount).toBeGreaterThan(0);
      expect(metadataResult.parameters.length).toBeGreaterThan(1);

      const preview = await client.callTool({
        name: "get_event_preview",
        arguments: {
          workspace_path: workspacePath,
          sample_id: "sample_001",
          x: metadataResult.parameters[0]?.name,
          y: metadataResult.parameters[1]?.name,
          max_events: 16,
        },
      });
      const previewResult = (preview.structuredContent as { result?: unknown } | undefined)?.result as {
        totalEvents: number;
        sampledEvents: number;
      };
      expect(previewResult.totalEvents).toBeGreaterThan(0);
      expect(previewResult.sampledEvents).toBeLessThanOrEqual(16);

      const badPreview = await client.callTool({
        name: "get_event_preview",
        arguments: {
          workspace_path: workspacePath,
          sample_id: "sample_001",
          x: "missing-channel",
          y: metadataResult.parameters[1]?.name,
          max_events: 16,
        },
      });
      const badPreviewResult = (badPreview.structuredContent as { result?: unknown } | undefined)?.result as {
        ok: boolean;
        errors: Array<{ path: string; code: string; message: string }>;
      };
      expect(badPreview.isError).toBe(true);
      expect(badPreviewResult.ok).toBe(false);
      expect(badPreviewResult.errors[0]?.path).toBe("/x");
      expect(badPreviewResult.errors[0]?.code).toBe("unknown_parameter");

      const plotContext = await client.callTool({
        name: "get_plot_context",
        arguments: {
          workspace_path: workspacePath,
          sample_id: "sample_001",
          x: metadataResult.parameters[0]?.name,
          y: metadataResult.parameters[1]?.name,
          max_events: 16,
        },
      });
      const plotContextResult = (plotContext.structuredContent as { result?: unknown } | undefined)?.result as {
        ok: boolean;
        revision: number;
        workspace: FlowcytoWorkspace;
        metadata: { sampleId: string; parameters: Array<{ name: string }>; keywords?: Record<string, string> };
        preview: { sampledEvents: number };
        bounds: { xMin: number; xMax: number; yMin: number; yMax: number };
        gates: WorkspaceGate[];
        gateSchema: { preferredTypes: string[]; requiredRevisionField: string };
        expected_revision: number;
      };
      expect(plotContextResult.ok).toBe(true);
      expect(plotContextResult.revision).toBe(0);
      expect(plotContextResult.workspace.revision).toBe(0);
      expect(plotContextResult.metadata.sampleId).toBe("sample_001");
      expect(plotContextResult.metadata.parameters.length).toBeGreaterThan(1);
      expect(plotContextResult.metadata.keywords).toBeUndefined();
      expect(plotContextResult.preview.sampledEvents).toBeLessThanOrEqual(16);
      expect(plotContextResult.bounds.xMax).toBeGreaterThan(plotContextResult.bounds.xMin);
      expect(plotContextResult.bounds.yMax).toBeGreaterThan(plotContextResult.bounds.yMin);
      expect(plotContextResult.gates).toEqual([]);
      expect(plotContextResult.gateSchema.preferredTypes).toContain("polygon");
      expect(plotContextResult.gateSchema.requiredRevisionField).toBe("expected_revision");
      expect(plotContextResult.expected_revision).toBe(0);

      const editorState = await client.callTool({
        name: "get_gate_editor_state",
        arguments: {
          workspace_path: workspacePath,
          sample_id: "sample_001",
          x: metadataResult.parameters[0]?.name,
          y: metadataResult.parameters[1]?.name,
          max_events: 16,
        },
      });
      const editorStateResult = (editorState.structuredContent as { result?: unknown } | undefined)?.result as {
        ok: boolean;
        revision: number;
        preview: { sampledEvents: number };
      };
      expect(editorStateResult.ok).toBe(true);
      expect(editorStateResult.revision).toBe(0);
      expect(editorStateResult.preview.sampledEvents).toBeLessThanOrEqual(16);

      const plotImage = await client.callTool({
        name: "render_plot_image",
        arguments: {
          workspace_path: workspacePath,
          sample_id: "sample_001",
          x: metadataResult.parameters[0]?.name,
          y: metadataResult.parameters[1]?.name,
          format: "bins",
          bin_width: 16,
          bin_height: 12,
          max_events: 1024,
        },
      });
      const plotImageResult = (plotImage.structuredContent as { result?: unknown } | undefined)?.result as {
        ok: boolean;
        image: { format: string; mimeType: string; bytes: number; path?: string };
      };
      expect(plotImageResult.ok).toBe(true);
      expect(plotImageResult.image).toMatchObject({ format: "svg", mimeType: "image/svg+xml" });
      expect(plotImageResult.image.bytes).toBeGreaterThan(100);
      expect(plotImageResult.image.path).toBeTruthy();
      await expect(fs.access(plotImageResult.image.path as string)).resolves.toBeUndefined();
      const plotImageContent = plotImage.content as Array<Record<string, unknown>>;
      expect(plotImageContent.some((entry) => entry.type === "image" && entry.mimeType === "image/svg+xml")).toBe(true);

      const plotImageFileOnly = await client.callTool({
        name: "render_plot_image",
        arguments: {
          workspace_path: workspacePath,
          sample_id: "sample_001",
          x: metadataResult.parameters[0]?.name,
          y: metadataResult.parameters[1]?.name,
          format: "bins",
          output: "file",
        },
      });
      const plotImageFileOnlyResult = (plotImageFileOnly.structuredContent as { result?: unknown } | undefined)?.result as {
        ok: boolean;
        image: { path?: string };
      };
      expect(plotImageFileOnlyResult.ok).toBe(true);
      expect(plotImageFileOnlyResult.image.path).toBeTruthy();
      expect((plotImageFileOnly.content as Array<Record<string, unknown>>).some((entry) => entry.type === "image")).toBe(false);

      const probe = await client.callTool({ name: "probe_inline_image", arguments: {} });
      const probeResult = (probe.structuredContent as { result?: unknown } | undefined)?.result as { ok: boolean; probes: unknown[] };
      expect(probeResult.ok).toBe(true);
      expect(probeResult.probes).toHaveLength(2);
      const probeContent = probe.content as Array<Record<string, unknown>>;
      expect(probeContent.filter((entry) => entry.type === "image")).toHaveLength(2);

      const rendered = await client.callTool({
        name: "open_gate_editor",
        arguments: { workspace_path: workspacePath, surface: "mcp_app", sample_id: "sample_001", max_events: 16 },
      });
      const renderedResult = (rendered.structuredContent as { result?: unknown } | undefined)?.result as {
        ok: boolean;
        surface: { kind: string; resourceUri: string; preferredWidth: number; preferredHeight: number };
      };
      expect(renderedResult.ok).toBe(true);
      expect(renderedResult.surface.kind).toBe("mcp_app");
      expect(renderedResult.surface.resourceUri).toBe("ui://flowcyto/gate-editor-v1.html");
      expect(renderedResult.surface.preferredWidth).toBe(620);

      const aliasRendered = await client.callTool({
        name: "render_gate_editor",
        arguments: { workspace_path: workspacePath, sample_id: "sample_001", max_events: 16 },
      });
      const aliasRenderedResult = (aliasRendered.structuredContent as { result?: unknown } | undefined)?.result as {
        ok: boolean;
        surface: { kind: string; resourceUri: string };
      };
      expect(aliasRenderedResult.ok).toBe(true);
      expect(aliasRenderedResult.surface.kind).toBe("mcp_app");
      expect(aliasRenderedResult.surface.resourceUri).toBe("ui://flowcyto/gate-editor-v1.html");

      const mcpCreate = await client.callTool({
        name: "upsert_gate",
        arguments: { workspace_path: workspacePath, gate: testGate("mcp_gate"), expected_revision: 0 },
      });
      const mcpCreateResult = (mcpCreate.structuredContent as { result?: unknown } | undefined)?.result as {
        ok: boolean;
        revision: number;
        gateCount: number;
        workspacePath: string;
      };
      expect(mcpCreateResult.ok).toBe(true);
      expect(mcpCreateResult.revision).toBe(1);
      expect(mcpCreateResult.gateCount).toBe(1);
      expect(mcpCreateResult.workspacePath).toBe(workspacePath);

      const staleMcpCreate = await client.callTool({
        name: "upsert_gate",
        arguments: { workspace_path: workspacePath, gate: { ...testGate("mcp_gate"), name: "stale" }, expected_revision: 0 },
      });
      const staleMcpCreateResult = (staleMcpCreate.structuredContent as { result?: unknown } | undefined)?.result as {
        ok: boolean;
        errors: Array<{ code: string; path: string; details?: Record<string, unknown> }>;
      };
      expect(staleMcpCreateResult.ok).toBe(false);
      expect(staleMcpCreateResult.errors[0]?.path).toBe("/revision");
      expect(staleMcpCreateResult.errors[0]?.code).toBe("stale_revision");
      expect(staleMcpCreateResult.errors[0]?.details).toEqual({ currentRevision: 1, expectedRevision: 0 });

      const revision = await client.callTool({
        name: "get_workspace_revision",
        arguments: { workspace_path: workspacePath },
      });
      const revisionResult = (revision.structuredContent as { result?: unknown } | undefined)?.result as {
        ok: boolean;
        revision: number;
        gateCount: number;
      };
      expect(revisionResult.ok).toBe(true);
      expect(revisionResult.revision).toBe(1);
      expect(revisionResult.gateCount).toBe(1);

      const mcpDelete = await client.callTool({
        name: "delete_gate",
        arguments: { workspace_path: workspacePath, gate_id: "mcp_gate", expected_revision: 1 },
      });
      const mcpDeleteResult = (mcpDelete.structuredContent as { result?: unknown } | undefined)?.result as {
        ok: boolean;
        revision: number;
        gateCount: number;
        workspacePath: string;
      };
      expect(mcpDeleteResult.ok).toBe(true);
      expect(mcpDeleteResult.revision).toBe(2);
      expect(mcpDeleteResult.gateCount).toBe(0);
      expect(mcpDeleteResult.workspacePath).toBe(workspacePath);

      const editor = await client.callTool({
        name: "open_gate_editor",
        arguments: { workspace_path: workspacePath, port: 0, max_events: 32 },
      });
      const editorResult = (editor.structuredContent as { result?: unknown } | undefined)?.result as {
        ok: boolean;
        surface: { kind: string; resourceUri: string; preferredWidth: number; preferredHeight: number };
      };
      expect(editorResult.ok).toBe(true);
      expect(editorResult.surface.kind).toBe("mcp_app");
      expect(editorResult.surface.resourceUri).toBe("ui://flowcyto/gate-editor-v1.html");
      expect(editorResult.surface.preferredHeight).toBe(620);
    } finally {
      await client.close();
    }
  });
});
