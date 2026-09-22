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
  buildBiexTransform,
  deleteGate,
  detectCompensationStatus,
  estimateCompensationFromControls,
  exportFlowJoWorkspace,
  extractSpilloverMatrices,
  formatTick,
  FlowcytoError,
  generateTicks,
  getEventPreview,
  getPopulationGraph,
  getPopulationTable,
  getSampleMetadata,
  importFlowJoWorkspace,
  initWorkspace,
  openFcsArtifact,
  readPreviewColumns,
  readWorkspace,
  propagateGates,
  suggestApoptosisQuadrants,
  suggestSingletGate,
  transformValue,
  upsertCompensationMatrix,
  upsertGate,
  upsertGates,
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
const compensationReferencePath = path.resolve("testdata/fixtures/compensation-reference.json");
const controlCompensationReferencePath = path.resolve("testdata/fixtures/control-compensation-reference.json");
const biexTransformReferencePath = path.resolve("testdata/fixtures/biex-transform-reference.json");
const flowJoFixtureDir = path.resolve("testdata/fixtures/flowjo");

type FixtureManifest = {
  fixtures: Array<{
    id: string;
    path: string;
    instrument?: string;
    classification?: "raw" | "compensated" | "unmixed";
    control?: { role: "unstained" | "single_stain"; channel?: string; mappingSource?: string };
    expected?: {
      minParameters?: number;
      minEvents?: number;
      requiredKeywords?: string[];
      spilloverKeyword?: string | null;
      spilloverChannels?: string[];
    };
  }>;
};

type BiexTransformReference = {
  generator: string;
  flowWorkspaceVersion: string;
  cases: Array<{
    label: string;
    parameters: {
      length: number;
      maxRange: number;
      pos: number;
      neg: number;
      width: number;
    };
    inputs: number[];
    display: number[];
    roundTrip: number[];
    roundTripMaxError: number;
    forwardToleranceDisplay: number;
    positiveForwardToleranceDisplay: number;
    positiveInputMask: boolean[];
    inverseToleranceData: number;
    forwardSpline: {
      x: number[];
      y: number[];
      b: number[];
      c: number[];
      d: number[];
    };
    inverseSpline: {
      x: number[];
      y: number[];
      b: number[];
      c: number[];
      d: number[];
    };
  }>;
};

type CompensationReference = {
  reference: string;
  cases: Array<{
    id: string;
    channels: string[];
    spillover: number[][];
    raw: number[][];
    expected: number[][];
  }>;
};

type ControlCompensationReference = {
  channels: string[];
  controls: { unstained: string; singleStain: Record<string, string> };
  flowcoreCompref: number[][];
  medianEstimate: { matrix: number[][]; maxAbsErrorVsCompref: number };
  failureModes: {
    filenameOrdinalMapping: { maxAbsErrorVsCompref: number; conditionNumber: number };
    noUnstainedBackground: { maxAbsErrorVsCompref: number };
  };
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

    const semicolon = extractSpilloverMatrices({
      keywords: { COMP: "2;FITC-A;PE-A;1;0.2;0.1;1" },
      sampleId: "sample_001",
      availableChannels: ["FITC-A", "PE-A"],
    });
    expect(semicolon.compensations[0]?.keyword).toBe("COMP");
    expect(semicolon.compensations[0]?.matrix).toEqual([[1, 0.2], [0.1, 1]]);

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

  it("imports nested linear FlowJo gates into a canonical workspace", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-flowjo-import-"));
    const samplePath = path.join(dir, "sample.fcs");
    await writeTinyIntegerFcs({
      fcsPath: samplePath,
      channels: ["FSC-A", "SSC-A", "FITC-A"],
      rows: [[100, 200, 300], [150, 250, 350], [200, 300, 400]],
    });
    const result = await importFlowJoWorkspace({
      wspPath: path.join(flowJoFixtureDir, "nested-hierarchy.wsp"),
      workspaceDir: dir,
      samplePathMap: { "sample.fcs": samplePath },
    });
    expect(result).toMatchObject({
      ok: true,
      samplesImported: 1,
      gatesImported: 3,
      compensationsImported: 0,
      warnings: [],
    });
    const workspace = await readWorkspace(result.workspacePath);
    const expected = JSON.parse(await fs.readFile(path.join(flowJoFixtureDir, "nested-hierarchy-expected-gates.json"), "utf8")) as WorkspaceGate[];
    expect(workspace.samples).toEqual([{ id: "sample", path: "sample.fcs" }]);
    expect(workspace.gates).toEqual(expected);
    expect((await validateWorkspace(result.workspacePath)).ok).toBe(true);
  });

  it("imports linear FlowJo rectangle gates with explicit sample id mapping", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-flowjo-rect-import-"));
    const samplePath = path.join(dir, "sample.fcs");
    await writeTinyIntegerFcs({
      fcsPath: samplePath,
      channels: ["FSC-A", "SSC-A"],
      rows: [[100, 200], [150, 250]],
    });
    const result = await importFlowJoWorkspace({
      wspPath: path.join(flowJoFixtureDir, "minimal-linear-rect.wsp"),
      workspaceDir: dir,
      sampleIdMap: { "sample.fcs": "rect_sample" },
      samplePathMap: { "sample.fcs": samplePath },
    });
    const workspace = await readWorkspace(result.workspacePath);
    expect(workspace.samples).toEqual([{ id: "rect_sample", path: "sample.fcs" }]);
    expect(workspace.gates).toEqual([{
      id: "gate-rect-001",
      name: "Main Population",
      sample: "rect_sample",
      parent: "root",
      type: "rect",
      x: "FSC-A",
      y: "SSC-A",
      xMin: 40000,
      xMax: 220000,
      yMin: 15000,
      yMax: 120000,
    }]);
  });

  it("imports one-dimensional FlowJo rectangle gates as range gates", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-flowjo-rect-range-import-"));
    const samplePath = path.join(dir, "sample.fcs");
    await writeTinyIntegerFcs({
      fcsPath: samplePath,
      channels: ["FITC-A"],
      rows: [[100], [150], [200]],
    });
    const result = await importFlowJoWorkspace({
      wspPath: path.join(flowJoFixtureDir, "minimal-linear-rect-range.wsp"),
      workspaceDir: dir,
      samplePathMap: { "sample.fcs": samplePath },
    });
    const workspace = await readWorkspace(result.workspacePath);
    expect(result).toMatchObject({ ok: true, samplesImported: 1, gatesImported: 1, warnings: [] });
    expect(workspace.gates).toEqual([{
      id: "gate-rect-range-001",
      name: "FITC Positive",
      sample: "sample",
      parent: "root",
      type: "range",
      x: "FITC-A",
      min: 1332.275866631284,
      max: 5720.832738323096,
    }]);
  });

  it("imports real FlowJo Population wrappers around gate geometry", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-flowjo-population-wrapper-"));
    const samplePath = path.join(dir, "sample.fcs");
    await writeTinyIntegerFcs({
      fcsPath: samplePath,
      channels: ["FS00-A", "SS02-A", "FL19-A"],
      markers: ["FSC-A", "SSC-A", "APC-A"],
      rows: [[100, 200, 300], [150, 250, 350]],
    });
    const result = await importFlowJoWorkspace({
      wspPath: path.join(flowJoFixtureDir, "population-wrapper.wsp"),
      workspaceDir: dir,
      samplePathMap: { "sample.fcs": samplePath },
    });
    expect(result).toMatchObject({ ok: true, samplesImported: 1, gatesImported: 3, warnings: [] });
    const workspace = await readWorkspace(result.workspacePath);
    expect(workspace.gates).toEqual([
      {
        id: "ID1783181596",
        name: "Lymphocytes",
        sample: "sample",
        parent: "root",
        type: "polygon",
        x: "FSC-A",
        y: "SSC-A",
        vertices: [[50000, 20000], [200000, 20000], [200000, 100000]],
      },
      {
        id: "ID1054706104",
        name: "Single Cells",
        sample: "sample",
        parent: "ID1783181596",
        type: "rect",
        x: "FSC-A",
        y: "SSC-A",
        xMin: 21592.577696526507,
        xMax: 166066.5521023766,
        yMin: 59077.2610441767,
        yMax: 88831.50200803213,
      },
      {
        id: "IDCOMPALIAS",
        name: "Compensated Alias",
        sample: "sample",
        parent: "ID1783181596",
        type: "range",
        x: "APC-A",
        min: 10,
        max: 100,
      },
    ]);
  });

  it("filters multi-sample FlowJo imports and preserves already-opened sample paths", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-flowjo-sample-filter-"));
    const openedSamplePath = path.join(dir, "opened-b1.fcs");
    const wspB1Path = path.join(dir, "wsp-b1.fcs");
    const wspB2Path = path.join(dir, "wsp-b2.fcs");
    for (const fcsPath of [openedSamplePath, wspB1Path, wspB2Path]) {
      await writeTinyIntegerFcs({
        fcsPath,
        channels: ["FSC-A", "SSC-A"],
        rows: [[100, 200], [150, 250]],
      });
    }
    const workspacePath = path.join(dir, "flowcyto.workspace.json");
    const existing: FlowcytoWorkspace = {
      version: 1,
      revision: 0,
      samples: [{ id: "B1_44_1-1", path: "opened-b1.fcs" }],
      views: [],
      gates: [],
    };
    await fs.writeFile(workspacePath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");

    const result = await importFlowJoWorkspace({
      wspPath: path.join(flowJoFixtureDir, "two-sample-linear.wsp"),
      workspaceDir: dir,
      sampleNames: ["B1 44 1-1.fcs"],
      sampleIdMap: { "B1 44 1-1.fcs": "B1_44_1-1" },
      samplePathMap: {
        "B1 44 1-1.fcs": wspB1Path,
        "B2 44 1-1.fcs": wspB2Path,
      },
    });

    expect(result).toMatchObject({ ok: true, samplesImported: 1, gatesImported: 1, warnings: [] });
    const workspace = await readWorkspace(result.workspacePath);
    expect(workspace.samples).toEqual([{ id: "B1_44_1-1", path: "opened-b1.fcs" }]);
    expect(workspace.gates).toEqual([expect.objectContaining({
      id: "gate-b1-lymph",
      name: "B1 Lymphocytes",
      sample: "B1_44_1-1",
      parent: "root",
      x: "FSC-A",
      y: "SSC-A",
    })]);
    const gate = workspace.gates[0];
    expect(gate?.type === "polygon" ? gate.vertices : []).toEqual([
      [500_000_000, 200_000_000],
      [2_000_000_000, 200_000_000],
      [2_000_000_000, 1_000_000_000],
    ]);
  });

  it("fails when a FlowJo sample filter matches no samples", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-flowjo-sample-filter-miss-"));
    const samplePath = path.join(dir, "b1.fcs");
    await writeTinyIntegerFcs({
      fcsPath: samplePath,
      channels: ["FSC-A", "SSC-A"],
      rows: [[100, 200], [150, 250]],
    });

    await expect(importFlowJoWorkspace({
      wspPath: path.join(flowJoFixtureDir, "two-sample-linear.wsp"),
      workspaceDir: dir,
      sampleNames: ["Missing sample.fcs"],
      samplePathMap: { "B1 44 1-1.fcs": samplePath },
    })).rejects.toMatchObject({ code: "flowjo_sample_filter_no_match" });
  });

  it("inverts FlowJo log, flog, and fasinh gate coordinates on import", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-flowjo-transform-import-"));
    const samplePath = path.join(dir, "transform-sample.fcs");
    await writeTinyIntegerFcs({
      fcsPath: samplePath,
      channels: ["LOG-A", "FLOG-A", "FASINH-A", "BIEX-A"],
      rows: [[100, 200, 300, 400], [150, 250, 350, 450]],
    });

    const result = await importFlowJoWorkspace({
      wspPath: path.join(flowJoFixtureDir, "transform-log-fasinh.wsp"),
      workspaceDir: dir,
      samplePathMap: { "transform-sample.fcs": samplePath },
    });
    const workspace = await readWorkspace(result.workspacePath);
    const logRect = workspace.gates.find((gate) => gate.id === "gate-log-rect");
    const fasinhRange = workspace.gates.find((gate) => gate.id === "gate-fasinh-range");
    const biexRange = workspace.gates.find((gate) => gate.id === "gate-biex-range");
    const biexRectRange = workspace.gates.find((gate) => gate.id === "gate-biex-rect-range");

    expect(result.warnings).toEqual([]);
    expect(logRect).toMatchObject({
      type: "rect",
      x: "LOG-A",
      y: "FLOG-A",
      xMin: 10,
      xMax: 100000,
      yMax: 10000,
    });
    expect(logRect?.type === "rect" ? logRect.yMin : Number.NaN).toBeCloseTo(316.22776601683796, 10);
    expect(fasinhRange).toMatchObject({
      type: "range",
      x: "FASINH-A",
    });
    if (fasinhRange?.type !== "range") throw new Error("Expected fasinh range gate.");
    const invertFasinh = (value: number) => {
      const m = 4;
      const a = 0.7;
      const length = 256;
      const t = 12000;
      return Math.sinh(((m + a) * Math.LN10 * value / length) - (a * Math.LN10)) * t / Math.sinh(m * Math.LN10);
    };
    expect(fasinhRange.min).toBeCloseTo(invertFasinh(100), 10);
    expect(fasinhRange.max).toBeCloseTo(invertFasinh(140), 10);
    const biexTransform = buildBiexTransform({
      length: 256,
      maxRange: 214748,
      pos: 4.3319291278,
      neg: 0,
      width: -10,
    });
    expect(biexRange).toMatchObject({ type: "range", x: "BIEX-A" });
    expect(biexRange?.type === "range" ? biexRange.min : Number.NaN).toBeCloseTo(biexTransform.inverse(10), 10);
    expect(biexRange?.type === "range" ? biexRange.max : Number.NaN).toBeCloseTo(biexTransform.inverse(100), 10);
    // One-dimensional RectangleGate with biex transform must apply the same coordinate
    // inversion as a RangeGate on the same channel and display-space values.
    expect(biexRectRange).toMatchObject({ type: "range", x: "BIEX-A" });
    expect(biexRectRange?.type === "range" ? biexRectRange.min : Number.NaN).toBeCloseTo(biexTransform.inverse(10), 10);
    expect(biexRectRange?.type === "range" ? biexRectRange.max : Number.NaN).toBeCloseTo(biexTransform.inverse(100), 10);
  });

  it("skips unsupported FlowJo gate types with warnings, promotes orphaned children to parent", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-flowjo-unsupported-"));
    const samplePath = path.join(dir, "sample.fcs");
    await writeTinyIntegerFcs({
      fcsPath: samplePath,
      channels: ["FSC-A", "SSC-A"],
      rows: [[100, 200], [150, 250]],
    });
    const result = await importFlowJoWorkspace({
      wspPath: path.join(flowJoFixtureDir, "unsupported-gate-types.wsp"),
      workspaceDir: dir,
      samplePathMap: { "sample.fcs": samplePath },
    });
    // EllipsoidGate and BooleanGate each produce a warning; child of EllipsoidGate is imported
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
    expect(result.warnings.some((w) => w.includes("EllipsoidGate"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("BooleanGate"))).toBe(true);
    // 2 supported gates: "Child of Ellipsoid" (promoted to root) + "Supported Sibling"
    expect(result.gatesImported).toBe(2);
    const workspace = await readWorkspace(result.workspacePath);
    // Child of unsupported EllipsoidGate is promoted to root parent
    const child = workspace.gates.find((g) => g.name === "Child of Ellipsoid");
    expect(child?.parent).toBe("root");
    const sibling = workspace.gates.find((g) => g.name === "Supported Sibling");
    expect(sibling?.parent).toBe("root");
  });

  it("does not overwrite existing gates when overwriteGates is false (default)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-flowjo-noreplace-"));
    const samplePath = path.join(dir, "sample.fcs");
    await writeTinyIntegerFcs({
      fcsPath: samplePath,
      channels: ["FSC-A", "SSC-A"],
      rows: [[100, 200], [150, 250]],
    });
    // First import
    await importFlowJoWorkspace({
      wspPath: path.join(flowJoFixtureDir, "minimal-linear-rect.wsp"),
      workspaceDir: dir,
      samplePathMap: { "sample.fcs": samplePath },
    });
    // Manually widen the gate in the workspace
    const workspacePath = path.join(dir, "flowcyto.workspace.json");
    const before = await readWorkspace(workspacePath);
    const modified = { ...before, gates: before.gates.map((g) => g.type === "rect" ? { ...g, xMax: 999999 } : g) };
    await fs.writeFile(workspacePath, `${JSON.stringify(modified, null, 2)}\n`, "utf8");
    // Re-import with default overwriteGates=false; should not clobber the modified gate.
    await importFlowJoWorkspace({
      wspPath: path.join(flowJoFixtureDir, "minimal-linear-rect.wsp"),
      workspaceDir: dir,
      samplePathMap: { "sample.fcs": samplePath },
    });
    const after = await readWorkspace(workspacePath);
    const gate = after.gates.find((g) => g.id === "gate-rect-001");
    expect(gate?.type === "rect" && gate.xMax).toBe(999999);
  });

  it("overwrites existing gates when overwriteGates is true", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-flowjo-overwrite-"));
    const samplePath = path.join(dir, "sample.fcs");
    await writeTinyIntegerFcs({
      fcsPath: samplePath,
      channels: ["FSC-A", "SSC-A"],
      rows: [[100, 200], [150, 250]],
    });
    await importFlowJoWorkspace({
      wspPath: path.join(flowJoFixtureDir, "minimal-linear-rect.wsp"),
      workspaceDir: dir,
      samplePathMap: { "sample.fcs": samplePath },
    });
    const workspacePath = path.join(dir, "flowcyto.workspace.json");
    const before = await readWorkspace(workspacePath);
    const modified = { ...before, gates: before.gates.map((g) => g.type === "rect" ? { ...g, xMax: 999999 } : g) };
    await fs.writeFile(workspacePath, `${JSON.stringify(modified, null, 2)}\n`, "utf8");
    // Re-import with overwriteGates=true; should restore the original gate bounds.
    await importFlowJoWorkspace({
      wspPath: path.join(flowJoFixtureDir, "minimal-linear-rect.wsp"),
      workspaceDir: dir,
      samplePathMap: { "sample.fcs": samplePath },
      overwriteGates: true,
    });
    const after = await readWorkspace(workspacePath);
    const gate = after.gates.find((g) => g.id === "gate-rect-001");
    expect(gate?.type === "rect" && gate.xMax).toBe(220000);
  });

  it("exports Flowcyto gates to FlowJo .wsp and imports them back", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-flowjo-export-"));
    const samplePath = path.join(dir, "sample.fcs");
    await writeTinyIntegerFcs({
      fcsPath: samplePath,
      channels: ["FSC-A", "SSC-A", "FITC-A", "APC-A"],
      rows: [[100, 200, 300, 400], [150, 250, 350, 450]],
    });
    const { workspacePath } = await initWorkspace({ rootDir: dir, samplePath, sampleId: "sample" });
    await upsertGate({
      workspacePath,
      expectedRevision: 0,
      gate: {
        id: "lymph",
        name: "Lymphocytes",
        sample: "sample",
        parent: "root",
        type: "polygon",
        x: "FSC-A",
        y: "SSC-A",
        vertices: [[10, 20], [100, 20], [100, 80]],
      },
    });
    await upsertGate({
      workspacePath,
      expectedRevision: 1,
      gate: {
        id: "live",
        name: "Live",
        sample: "sample",
        parent: "lymph",
        type: "rect",
        x: "FSC-A",
        y: "SSC-A",
        xMin: 20,
        xMax: 90,
        yMin: 25,
        yMax: 75,
      },
    });
    await upsertGate({
      workspacePath,
      expectedRevision: 2,
      gate: {
        id: "fitc_positive",
        name: "FITC+",
        sample: "sample",
        parent: "live",
        type: "range",
        x: "FITC-A",
        min: 300,
        max: 900,
      },
    });
    await upsertGate({
      workspacePath,
      expectedRevision: 3,
      gate: {
        id: "apc_positive",
        name: "APC+",
        sample: "sample",
        parent: "live",
        type: "range",
        x: "APC-A",
        min: 150,
        max: 300,
      },
    });
    const workspaceWithViews = await readWorkspace(workspacePath);
    await fs.writeFile(workspacePath, `${JSON.stringify({
      ...workspaceWithViews,
      views: [
        {
          id: "fitc_log_view",
          sample: "sample",
          parent: "live",
          x: "FITC-A",
          y: "SSC-A",
          scale: { x: "log", y: "linear" },
        },
        {
          id: "apc_arcsinh_view",
          sample: "sample",
          parent: "live",
          x: "APC-A",
          y: "SSC-A",
          scale: { x: "arcsinh", y: "linear" },
        },
      ],
    }, null, 2)}\n`, "utf8");
    const outputPath = path.join(dir, "exported.wsp");
    const exported = await exportFlowJoWorkspace({ workspacePath, outputPath });
    expect(exported).toMatchObject({
      ok: true,
      wspPath: outputPath,
      samplesExported: 1,
      gatesExported: 4,
      compensationExported: false,
    });
    const xml = await fs.readFile(outputPath, "utf8");
    expect(xml).toContain("<Cytometers>");
    expect(xml).toContain("<transforms:log");
    expect(xml).toContain("<transforms:fasinh");
    expect(xml).toContain("<gating:PolygonGate");
    expect(xml).toContain("<gating:RectangleGate");
    expect(xml).toContain("<gating:RangeGate");
    expect(xml).toContain('<DataSet uri="file:');
    expect(xml).toContain('sampleID="1"');
    expect(xml).toContain('<Population name="Lymphocytes"');
    expect(xml).toMatch(/<Population name="Lymphocytes"[\s\S]*?<Gate gating:id="lymph"[\s\S]*?<gating:PolygonGate/);
    expect(xml).toMatch(/<SampleNode name="sample\.fcs"[\s\S]*?<Graph[^>]*>[\s\S]*?<Axis dimension="x" name="FSC-A"[\s\S]*?<Axis dimension="y" name="SSC-A"/);
    expect(xml).toMatch(/<Population name="Lymphocytes"[\s\S]*?<Graph[^>]*>[\s\S]*?<Axis dimension="x" name="FSC-A"[\s\S]*?<Axis dimension="y" name="SSC-A"/);
    // Gate dimensions must use fcs-dimension (raw $PnN lookup), not data-type:parameter,
    // because compensation-ref="uncompensated" requires direct FCS channel references.
    // (data-type:parameter is still correct inside <transforms:*> entries.)
    expect(xml).toContain("data-type:fcs-dimension");
    expect(xml).not.toMatch(/<gating:dimension[\s\S]*?<data-type:parameter/);
    // Gate IDs must live only on <Gate>, not repeated on geometry elements.
    // Real FlowJo WSP format puts gating:id only on the wrapper, not on PolygonGate etc.
    expect(xml).not.toMatch(/<gating:PolygonGate[^>]*gating:id/);
    expect(xml).not.toMatch(/<gating:RectangleGate[^>]*gating:id/);
    expect(xml).not.toMatch(/<gating:RangeGate[^>]*gating:id/);
    expect(xml).not.toMatch(/<gating:QuadrantGate[^>]*gating:id/);
    // compensation-ref must not appear on <gating:dimension> — it causes FlowJo to look up
    // scatter channels (FSC-A, SSC-A) in the transform matrix list where they don't exist.
    expect(xml).not.toMatch(/<gating:dimension[^>]*gating:compensation-ref/);
    expect(exported.warnings.some((warning) => warning.includes("LayoutEditor"))).toBe(true);

    const roundTripDir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-flowjo-roundtrip-"));
    const imported = await importFlowJoWorkspace({
      wspPath: outputPath,
      workspaceDir: roundTripDir,
      samplePathMap: { "sample.fcs": samplePath },
    });
    const roundTripWorkspace = await readWorkspace(imported.workspacePath);
    const originalGates = (await readWorkspace(workspacePath)).gates;
    expect(roundTripWorkspace.gates).toHaveLength(originalGates.length);
    for (const originalGate of originalGates) {
      const roundTripGate = roundTripWorkspace.gates.find((gate) => gate.id === originalGate.id);
      expect(roundTripGate).toBeDefined();
      expect(roundTripGate).toMatchObject({
        id: originalGate.id,
        name: originalGate.name,
        sample: originalGate.sample,
        parent: originalGate.parent,
        type: originalGate.type,
      });
      if (originalGate.type === "polygon") {
        if (roundTripGate?.type !== "polygon") throw new Error("Expected polygon round-trip gate.");
        expect(roundTripGate.x).toBe(originalGate.x);
        expect(roundTripGate.y).toBe(originalGate.y);
        expect(roundTripGate.vertices).toEqual(originalGate.vertices);
      }
      if (originalGate.type === "rect") {
        if (roundTripGate?.type !== "rect") throw new Error("Expected rect round-trip gate.");
        expect(roundTripGate.xMin).toBeCloseTo(originalGate.xMin, 10);
        expect(roundTripGate.xMax).toBeCloseTo(originalGate.xMax, 10);
        expect(roundTripGate.yMin).toBeCloseTo(originalGate.yMin, 10);
        expect(roundTripGate.yMax).toBeCloseTo(originalGate.yMax, 10);
      }
      if (originalGate.type === "range") {
        if (roundTripGate?.type !== "range") throw new Error("Expected range round-trip gate.");
        expect(roundTripGate.x).toBe(originalGate.x);
        expect(roundTripGate.min).toBeCloseTo(originalGate.min, 10);
        expect(roundTripGate.max).toBeCloseTo(originalGate.max, 10);
      }
    }
  });

  it("exportFlowJoWorkspace writes FlowJo biex metadata with raw gate coordinates", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-flowjo-export-biex-"));
    const samplePath = path.join(dir, "sample.fcs");
    await writeTinyIntegerFcs({
      fcsPath: samplePath,
      channels: ["FSC-A", "SSC-A", "FITC-A"],
      rows: [[100, 200, 300]],
    });
    const { workspacePath } = await initWorkspace({ rootDir: dir, samplePath, sampleId: "sample" });
    await upsertGate({
      workspacePath,
      expectedRevision: 0,
      gate: {
        id: "fitc_positive",
        name: "FITC+",
        sample: "sample",
        parent: "root",
        type: "range",
        x: "FITC-A",
        min: 300,
        max: 900,
      },
    });
    const workspace = await readWorkspace(workspacePath);
    await fs.writeFile(workspacePath, `${JSON.stringify({
      ...workspace,
      views: [{
        id: "fitc_biex_view",
        sample: "sample",
        parent: "root",
        x: "FITC-A",
        y: "SSC-A",
        scale: { x: "biex", y: "linear" },
      }],
    }, null, 2)}\n`, "utf8");

    const outputPath = path.join(dir, "out.wsp");
    const result = await exportFlowJoWorkspace({
      workspacePath,
      outputPath,
    });
    expect(result.gatesExported).toBe(1);
    const xml = await fs.readFile(outputPath, "utf8");
    expect(xml).toContain("<transforms:biex");
    expect(xml).toContain('transforms:width="-1000"');
    expect(xml).toMatch(/<gating:dimension gating:min="300" gating:max="900">/);

    const importedDir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-flowjo-export-biex-roundtrip-"));
    const imported = await importFlowJoWorkspace({
      wspPath: outputPath,
      workspaceDir: importedDir,
      samplePathMap: { "sample.fcs": samplePath },
    });
    expect(imported.warnings).toEqual([]);
    const roundTrip = await readWorkspace(imported.workspacePath);
    const gate = roundTrip.gates.find((entry) => entry.id === "fitc_positive");
    expect(Math.abs((gate?.type === "range" ? gate.min : Number.NaN) - 300)).toBeLessThan(1e-3);
    expect(Math.abs((gate?.type === "range" ? gate.max : Number.NaN) - 900)).toBeLessThan(1e-3);
  });

  it("exportFlowJoWorkspace rejects conflicting channel scales across views", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-flowjo-export-ambig-"));
    const samplePath = path.join(dir, "sample.fcs");
    await writeTinyIntegerFcs({
      fcsPath: samplePath,
      channels: ["FSC-A", "FITC-A"],
      rows: [[100, 300]],
    });
    const { workspacePath } = await initWorkspace({ rootDir: dir, samplePath, sampleId: "sample" });
    await upsertGate({
      workspacePath,
      expectedRevision: 0,
      gate: { id: "g1", sample: "sample", parent: "root", type: "range", x: "FITC-A", min: 100, max: 500 },
    });
    const ws = await readWorkspace(workspacePath);
    await fs.writeFile(workspacePath, `${JSON.stringify({
      ...ws,
      views: [
        { id: "v1", sample: "sample", parent: "root", x: "FITC-A", y: "FSC-A", scale: { x: "log", y: "linear" } },
        { id: "v2", sample: "sample", parent: "root", x: "FITC-A", y: "FSC-A", scale: { x: "arcsinh", y: "linear" } },
      ],
    }, null, 2)}\n`, "utf8");
    await expect(exportFlowJoWorkspace({
      workspacePath,
      outputPath: path.join(dir, "out.wsp"),
    })).rejects.toMatchObject({ code: "ambiguous_flowjo_transform" });
  });

  it("exportFlowJoWorkspace keeps zero gate coordinates raw under log display transforms", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-flowjo-export-nonfinite-"));
    const samplePath = path.join(dir, "sample.fcs");
    await writeTinyIntegerFcs({
      fcsPath: samplePath,
      channels: ["FSC-A", "FITC-A"],
      rows: [[100, 300]],
    });
    const { workspacePath } = await initWorkspace({ rootDir: dir, samplePath, sampleId: "sample" });
    await upsertGate({
      workspacePath,
      expectedRevision: 0,
      gate: { id: "g1", sample: "sample", parent: "root", type: "range", x: "FITC-A", min: 0, max: 500 },
    });
    const ws = await readWorkspace(workspacePath);
    await fs.writeFile(workspacePath, `${JSON.stringify({
      ...ws,
      views: [{ id: "v1", sample: "sample", parent: "root", x: "FITC-A", y: "FSC-A", scale: { x: "log", y: "linear" } }],
    }, null, 2)}\n`, "utf8");
    await exportFlowJoWorkspace({
      workspacePath,
      outputPath: path.join(dir, "out.wsp"),
    });
    const xml = await fs.readFile(path.join(dir, "out.wsp"), "utf8");
    expect(xml).toContain("<transforms:log");
    expect(xml).toMatch(/<gating:dimension gating:min="0" gating:max="500">/);
  });

  it("exportFlowJoWorkspace rejects an unknown compensationId", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-flowjo-export-comp-"));
    const samplePath = path.join(dir, "sample.fcs");
    await writeTinyIntegerFcs({
      fcsPath: samplePath,
      channels: ["FSC-A", "SSC-A"],
      rows: [[100, 200]],
    });
    const { workspacePath } = await initWorkspace({ rootDir: dir, samplePath, sampleId: "sample" });
    const outputPath = path.join(dir, "out.wsp");
    await expect(exportFlowJoWorkspace({
      workspacePath,
      outputPath,
      compensationId: "no_such_comp",
    })).rejects.toMatchObject({ code: "unknown_compensation" });
  });

  it("exportFlowJoWorkspace writes the selected compensation matrix", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-flowjo-export-compwarn-"));
    const samplePath = path.join(dir, "sample.fcs");
    await writeTinyIntegerFcs({
      fcsPath: samplePath,
      channels: ["FSC-A", "SSC-A"],
      rows: [[100, 200]],
    });
    const { workspacePath } = await initWorkspace({ rootDir: dir, samplePath, sampleId: "sample" });
    await upsertCompensationMatrix({
      workspacePath,
      expectedRevision: 0,
      compensation: {
        id: "my_comp",
        source: "manual",
        channels: ["FSC-A", "SSC-A"],
        matrix: [[1, 0], [0, 1]],
      },
    });
    const outputPath = path.join(dir, "out.wsp");
    const result = await exportFlowJoWorkspace({ workspacePath, outputPath, compensationId: "my_comp" });
    expect(result).toMatchObject({ ok: true, compensationExported: true, warnings: [] });
    const xml = await fs.readFile(outputPath, "utf8");
    expect(xml).toContain('<Matrices>');
    expect(xml).toContain('<transforms:spilloverMatrix');
    expect(xml).toContain('transforms:id="my_comp"');
    expect(xml).toContain('data-type:name="Comp-FSC-A"');
    expect(xml).toContain('data-type:name="Comp-SSC-A"');
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

      // Pin the spillover evidence each fixture is carried for. `null` asserts the
      // absence of every variant, so a fixture cannot quietly be adopted as an
      // embedded-matrix baseline when it has no matrix at all.
      if (fixture.expected?.spilloverKeyword !== undefined) {
        const extracted = extractSpilloverMatrices({
          keywords: metadata.keywords,
          sampleId: fixture.id,
          availableChannels: metadata.parameters.map((parameter) => parameter.name),
        });
        if (fixture.expected.spilloverKeyword === null) {
          expect(extracted.diagnostics.keywordsFound, `${fixture.id} unexpectedly carries a spillover keyword`).toEqual([]);
          expect(extracted.compensations, fixture.id).toEqual([]);
        } else {
          expect(extracted.diagnostics.keywordsFound, fixture.id).toContain(fixture.expected.spilloverKeyword);
          expect(extracted.compensations[0]?.keyword, fixture.id).toBe(fixture.expected.spilloverKeyword);
          if (fixture.expected.spilloverChannels) {
            expect(extracted.compensations[0]?.channels, fixture.id).toEqual(fixture.expected.spilloverChannels);
          }
        }
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
  }, 30000);

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

  it("reproduces flowCore's published matrix from the real single-stain controls", async () => {
    // End-to-end against real log-amplified data: the five flowCore compdata controls
    // through the shipped estimator must reproduce the matrix flowCore's own
    // spillover() published from them. This is the check that $PnE linearization
    // exists at all -- without it the FL1->FL2 coefficient comes out at 0.72
    // instead of 0.24, and the assertion below fails by a wide margin.
    const reference = JSON.parse(await fs.readFile(controlCompensationReferencePath, "utf8")) as ControlCompensationReference;
    const manifest = await readFixtureManifest();
    const resolve = (id: string) => {
      const fixture = manifest.fixtures.find((entry) => entry.id === id);
      expect(fixture, `${id} must be in the manifest`).toBeTruthy();
      return path.resolve(fixture!.path);
    };

    const estimated = await estimateCompensationFromControls({
      channels: reference.channels,
      unstainedPath: resolve(reference.controls.unstained),
      // Mapping is declared in the manifest from flowCore's comp_match, never guessed
      // from filenames: .004 is FL4-H and .005 is FL3-H, so ordinal order is wrong.
      controls: Object.entries(reference.controls.singleStain)
        .map(([id, channel]) => ({ path: resolve(id), channel }))
        .sort((a, b) => reference.channels.indexOf(a.channel) - reference.channels.indexOf(b.channel)),
    });

    reference.flowcoreCompref.forEach((row, i) => row.forEach((expectedValue, j) => {
      expect(estimated.compensation.matrix[i][j], `matrix[${i}][${j}]`).toBeCloseTo(expectedValue, 9);
    }));
  });

  it("keeps the single-stain control mapping explicit and complete", async () => {
    // Guards the boundary that control-to-channel mapping is declared data, not
    // inferred. The reference analysis reads this mapping; if it drifts from
    // flowCore's comp_match the estimate silently stops matching compref.
    const manifest = await readFixtureManifest();
    const controls = manifest.fixtures.filter((fixture) => fixture.control);
    const unstained = controls.filter((fixture) => fixture.control?.role === "unstained");
    const singleStains = controls.filter((fixture) => fixture.control?.role === "single_stain");

    expect(unstained).toHaveLength(1);
    expect(singleStains.length).toBeGreaterThanOrEqual(2);
    for (const fixture of singleStains) {
      expect(fixture.control?.channel, `${fixture.id} must declare its channel`).toBeTruthy();
      expect(fixture.control?.mappingSource, `${fixture.id} must record where the mapping came from`).toBeTruthy();
    }

    const channels = singleStains.map((fixture) => fixture.control?.channel);
    expect(new Set(channels).size, "each channel may be claimed by only one control").toBe(channels.length);

    // The mapping must not be recoverable from filename order. That is the failure
    // mode the reference analysis quantifies, and it only stays exercised if the
    // fixture set keeps a corpus where guessing is wrong.
    const byFilename = [...singleStains].sort((a, b) => a.id.localeCompare(b.id)).map((f) => f.control?.channel);
    expect(byFilename, "controls must not happen to be in channel order").not.toEqual([...channels].sort());
  });

  it("carries a control-derived reference that reproduces flowCore's published matrix", async () => {
    const reference = JSON.parse(await fs.readFile(controlCompensationReferencePath, "utf8")) as ControlCompensationReference;

    expect(reference.medianEstimate.maxAbsErrorVsCompref).toBeLessThan(1e-12);
    reference.flowcoreCompref.forEach((row, i) => row.forEach((expectedValue, j) => {
      expect(reference.medianEstimate.matrix[i][j]).toBeCloseTo(expectedValue, 10);
    }));

    // Failure modes must stay failures. If any of these quietly starts agreeing with
    // compref, the analysis behind the estimator guardrails no longer holds.
    expect(reference.failureModes.filenameOrdinalMapping.maxAbsErrorVsCompref).toBeGreaterThan(1);
    expect(reference.failureModes.filenameOrdinalMapping.conditionNumber).toBeGreaterThan(100);
    expect(reference.failureModes.noUnstainedBackground.maxAbsErrorVsCompref).toBeGreaterThan(0.05);

    // The reference matrix must be consumable by the shipped compensation path.
    const applied = applyCompensationColumns({
      channels: reference.channels,
      values: [[100, 50, 20, 10]],
      compensation: {
        id: "control_reference",
        source: "controls",
        channels: reference.channels,
        matrix: reference.medianEstimate.matrix,
      },
    });
    expect(applied.compensation.applied).toBe(true);
    applied.values[0].forEach((value) => expect(Number.isFinite(value)).toBe(true));
  });

  it("recovers a known spillover matrix from synthesised single-stain controls", async () => {
    // End-to-end check of the shipped estimator against a matrix we chose, on linear
    // data. Each control is synthesised as brightness * S[stain] + background, which
    // is exactly what a single-stain acquisition measures, so the estimator must
    // return S. Uses round values so 16-bit integer storage is lossless.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-control-recover-"));
    const channels = ["FL1-A", "FL2-A", "FL3-A"];
    const spillover = [
      [1, 0.2, 0.05],
      [0.01, 1, 0.15],
      [0.002, 0.03, 1],
    ];
    const brightness = 10000;
    const background = [10, 20, 30];
    const triple = (row: number[]): number[][] => [row, row, row];

    const unstainedPath = path.join(dir, "unstained.fcs");
    await writeTinyIntegerFcs({ fcsPath: unstainedPath, channels, rows: triple(background) });

    const controls = await Promise.all(spillover.map(async (row, index) => {
      const controlPath = path.join(dir, `stain-${index}.fcs`);
      const observed = row.map((coefficient, detector) => brightness * coefficient + background[detector]);
      expect(observed.every((value) => Number.isInteger(value) && value <= 65535)).toBe(true);
      await writeTinyIntegerFcs({ fcsPath: controlPath, channels, rows: triple(observed) });
      return { path: controlPath, channel: channels[index] };
    }));

    const estimated = await estimateCompensationFromControls({ channels, unstainedPath, controls });
    expect(estimated.compensation.channels).toEqual(channels);
    spillover.forEach((row, i) => row.forEach((expectedValue, j) => {
      expect(estimated.compensation.matrix[i][j], `matrix[${i}][${j}]`).toBeCloseTo(expectedValue, 12);
    }));

    // Compensating the background-subtracted controls must put each stain entirely
    // back into its own detector and zero the others. Background is subtracted first
    // because compensation is linear and would otherwise redistribute it too.
    const applied = applyCompensationColumns({
      channels,
      values: spillover.map((row) => row.map((coefficient) => brightness * coefficient)),
      compensation: estimated.compensation,
    });
    applied.values.forEach((row, stain) => row.forEach((value, detector) => {
      expect(value, `stain ${stain} in detector ${detector}`).toBeCloseTo(stain === detector ? brightness : 0, 6);
    }));
  });

  it("cannot distinguish an already-compensated export from its raw source", async () => {
    // Scenario C, with a real file pair rather than a hypothetical: PeacoQC ships the
    // same sample raw and already compensated. The compensated export kept its SPILL
    // keyword and its unprefixed detector channel names, so every signal the detector
    // looks for is absent from both. This test documents the gap; it is expected to
    // show the two as identical until some positive evidence of raw data exists.
    const manifest = await readFixtureManifest();
    const pair = ["peacoqc-111-raw", "peacoqc-111-comp-trans"]
      .map((id) => manifest.fixtures.find((fixture) => fixture.id === id));
    expect(pair.every(Boolean), "both PeacoQC fixtures must be in the manifest").toBe(true);
    expect(pair[0]?.classification).toBe("raw");
    expect(pair[1]?.classification).toBe("compensated");

    const statuses = [];
    for (const fixture of pair) {
      const { workspacePath } = await makeWorkspaceFromFixture(path.resolve(fixture!.path), fixture!.id);
      const metadata = await getSampleMetadata(workspacePath, fixture!.id);
      const channels = metadata.parameters.map((parameter) => parameter.name);
      const { compensations } = extractSpilloverMatrices({
        keywords: metadata.keywords,
        sampleId: "shared",
        availableChannels: channels,
      });
      statuses.push(detectCompensationStatus({ keywords: metadata.keywords, channels, compensations }));
    }
    const [rawStatus, compensatedStatus] = statuses;

    // Both carry a matrix, and neither trips a pre-compensation signal.
    expect(rawStatus.embeddedMatrixFound).toBe(true);
    expect(compensatedStatus.embeddedMatrixFound).toBe(true);
    expect(compensatedStatus.detectedAsPreCompensated).toBe(false);

    // The detector produces byte-identical output for raw and compensated data.
    // Sample ids are normalized above so only the detection result is compared.
    expect(compensatedStatus).toEqual(rawStatus);

    // Since they cannot be told apart, the status must at least say so rather than
    // offering a bare suggestion that reads as an endorsement.
    for (const status of statuses) {
      expect(status.signals).toContain(
        "Compensation state unverifiable: no signal distinguishes raw from already-compensated data.",
      );
    }
  });

  it("matches the external numpy compensation reference", async () => {
    const reference = JSON.parse(await fs.readFile(compensationReferencePath, "utf8")) as CompensationReference;
    expect(reference.reference).toBe("numpy.linalg.solve(S.T, X.T).T");
    expect(reference.cases.length).toBeGreaterThan(0);

    for (const testCase of reference.cases) {
      const applied = applyCompensationColumns({
        channels: testCase.channels,
        values: testCase.raw,
        compensation: {
          id: `reference_${testCase.id}`,
          source: "manual",
          channels: testCase.channels,
          matrix: testCase.spillover,
        },
      });

      // Relative tolerance: the reference is rounded to 12 significant digits and
      // ml-matrix and LAPACK take different elimination paths, so exact equality is
      // not expected. 1e-9 relative is far tighter than any spillover difference
      // that could change an analysis result.
      testCase.expected.forEach((expectedRow, rowIndex) => {
        expectedRow.forEach((expectedValue, columnIndex) => {
          const actual = applied.values[rowIndex]?.[columnIndex];
          const tolerance = Math.max(Math.abs(expectedValue), 1) * 1e-9;
          expect(
            Math.abs((actual ?? Number.NaN) - expectedValue),
            `${testCase.id} [${rowIndex}][${columnIndex}] expected ${expectedValue}, got ${actual}`,
          ).toBeLessThan(tolerance);
        });
      });
    }
  });

  it("keeps spillover orientation detectable, so a transposed matrix cannot pass unnoticed", async () => {
    // Guards the reference fixture itself. If every case were symmetric, the test
    // above would pass against a transposed implementation and prove nothing.
    const reference = JSON.parse(await fs.readFile(compensationReferencePath, "utf8")) as CompensationReference;
    const asymmetric = reference.cases.filter((testCase) => testCase.spillover
      .some((row, i) => row.some((value, j) => Math.abs(value - testCase.spillover[j][i]) > 1e-12)));
    expect(asymmetric.length, "reference must contain asymmetric matrices").toBeGreaterThan(0);

    for (const testCase of asymmetric) {
      const transposed = testCase.spillover.map((_, i) => testCase.spillover.map((row) => row[i]));
      const applied = applyCompensationColumns({
        channels: testCase.channels,
        values: testCase.raw,
        compensation: {
          id: `transposed_${testCase.id}`,
          source: "manual",
          channels: testCase.channels,
          matrix: transposed,
        },
      });
      const differs = testCase.expected.some((expectedRow, rowIndex) => expectedRow
        .some((expectedValue, columnIndex) => Math.abs((applied.values[rowIndex]?.[columnIndex] ?? Number.NaN) - expectedValue) > 1e-6));
      expect(differs, `${testCase.id} produces identical output when transposed`).toBe(true);
    }
  });

  it("agrees on matrix orientation between embedded keywords and single-stain controls", async () => {
    // Both paths write CompensationMatrix.matrix and both are consumed by
    // applyCompensationColumns, so they must use the same convention. They did not:
    // the control estimator was transposed relative to the embedded parser, and
    // nothing compared them. Same panel, both routes, one expected matrix.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-orientation-"));
    const channels = ["FSC-A", "SSC-A", "FITC-A", "PE-A"];

    // FITC leaks 20% into PE; PE leaks 2.5% into FITC.
    const expected = [[1, 0.2], [0.025, 1]];

    const embedded = extractSpilloverMatrices({
      keywords: { $SPILLOVER: "2,FITC-A,PE-A,1,0.2,0.025,1" },
      sampleId: "orientation",
      availableChannels: channels,
    }).compensations[0];
    expect(embedded.matrix).toEqual(expected);

    // Single-stain controls describing that same panel, on top of a shared background.
    const unstainedPath = path.join(dir, "unstained.fcs");
    const fitcPath = path.join(dir, "fitc.fcs");
    const pePath = path.join(dir, "pe.fcs");
    const triple = (row: number[]): number[][] => [row, row, row];
    await writeTinyIntegerFcs({ fcsPath: unstainedPath, channels, rows: triple([1, 2, 10, 20]) });
    // FITC control: 100 over background in FITC, and 20 of that lands in PE.
    await writeTinyIntegerFcs({ fcsPath: fitcPath, channels, rows: triple([1, 2, 110, 40]) });
    // PE control: 200 over background in PE, and 5 of that lands in FITC.
    await writeTinyIntegerFcs({ fcsPath: pePath, channels, rows: triple([1, 2, 15, 220]) });

    const estimated = await estimateCompensationFromControls({
      channels: ["FITC-A", "PE-A"],
      unstainedPath,
      controls: [
        { path: fitcPath, channel: "FITC-A" },
        { path: pePath, channel: "PE-A" },
      ],
    });
    expect(estimated.compensation.matrix).toEqual(expected);
    expect(estimated.compensation.matrix).toEqual(embedded.matrix);

    // And the shared apply path must therefore treat them identically.
    const applyVia = (matrix: number[][]) => applyCompensationColumns({
      values: [[100, 200]],
      channels: ["FITC-A", "PE-A"],
      compensation: { id: "orientation", source: "manual", channels: ["FITC-A", "PE-A"], matrix },
    }).values[0];
    const viaEmbedded = applyVia(embedded.matrix);
    const viaControls = applyVia(estimated.compensation.matrix);
    viaEmbedded.forEach((value, index) => expect(viaControls[index]).toBeCloseTo(value, 10));
  });

  it("estimates and stores conventional compensation from explicit single-stain controls", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-control-comp-"));
    const unstainedPath = path.join(dir, "unstained.fcs");
    const fitcPath = path.join(dir, "fitc.fcs");
    const pePath = path.join(dir, "pe.fcs");
    await writeTinyIntegerFcs({
      fcsPath: unstainedPath,
      channels: ["FSC-A", "SSC-A", "FITC-A", "PE-A"],
      rows: [
        [1, 2, 10, 20],
        [1, 2, 10, 20],
        [1, 2, 10, 20],
      ],
    });
    await writeTinyIntegerFcs({
      fcsPath: fitcPath,
      channels: ["FSC-A", "SSC-A", "FITC-A", "PE-A"],
      rows: [
        [1, 2, 110, 40],
        [1, 2, 110, 40],
        [1, 2, 110, 40],
      ],
    });
    await writeTinyIntegerFcs({
      fcsPath: pePath,
      channels: ["FSC-A", "SSC-A", "FITC-A", "PE-A"],
      rows: [
        [1, 2, 15, 220],
        [1, 2, 15, 220],
        [1, 2, 15, 220],
      ],
    });

    const estimated = await estimateCompensationFromControls({
      id: "controls_fitc_pe",
      sample: "comp_sample",
      channels: ["FITC-A", "PE-A"],
      unstainedPath,
      controls: [
        { path: fitcPath, channel: "FITC-A" },
        { path: pePath, channel: "PE-A" },
      ],
    });
    expect(estimated.compensation).toMatchObject({
      id: "controls_fitc_pe",
      source: "controls",
      sample: "comp_sample",
      channels: ["FITC-A", "PE-A"],
      // Background-subtracted, the FITC control reads 100 in FITC and 20 in PE, so
      // FITC leaks 20% into the PE detector: that belongs at matrix[FITC][PE].
      // The PE control reads 5 in FITC against 200 in PE, giving 2.5% the other way.
      matrix: [[1, 0.2], [0.025, 1]],
    });
    expect(estimated.diagnostics.method).toBe("median_ratio");

    const { workspacePath } = await makeWorkspaceFromFixture(fixturePath, "comp_sample");
    const upserted = await upsertCompensationMatrix({
      workspacePath,
      expectedRevision: 0,
      compensation: estimated.compensation,
    });
    expect(upserted.revision).toBe(1);
    const workspace = await readWorkspace(workspacePath);
    expect(workspace.compensations?.[0]).toMatchObject({
      id: "controls_fitc_pe",
      source: "controls",
      channels: ["FITC-A", "PE-A"],
    });
    await expect(upsertCompensationMatrix({
      workspacePath,
      expectedRevision: 0,
      compensation: estimated.compensation,
    })).rejects.toMatchObject({ code: "stale_revision" });
  });

  it("resolves detector aliases for control-derived compensation inputs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-control-comp-alias-"));
    const unstainedPath = path.join(dir, "unstained.fcs");
    const fitcPath = path.join(dir, "fitc.fcs");
    const pePath = path.join(dir, "pe.fcs");
    const detectorChannels = ["FL03-A", "FL13-A"];
    const parameterNames = ["FITC-A", "PE-A"];
    await writeTinyIntegerFcs({
      fcsPath: unstainedPath,
      channels: detectorChannels,
      markers: parameterNames,
      rows: [[10, 20], [10, 20], [10, 20]],
    });
    await writeTinyIntegerFcs({
      fcsPath: fitcPath,
      channels: detectorChannels,
      markers: parameterNames,
      rows: [[110, 40], [110, 40], [110, 40]],
    });
    await writeTinyIntegerFcs({
      fcsPath: pePath,
      channels: detectorChannels,
      markers: parameterNames,
      rows: [[15, 220], [15, 220], [15, 220]],
    });

    const estimated = await estimateCompensationFromControls({
      channels: detectorChannels,
      unstainedPath,
      controls: [
        { path: fitcPath, channel: "FL03-A" },
        { path: pePath, channel: "FL13-A" },
      ],
    });

    expect(estimated.compensation.channels).toEqual(parameterNames);
    expect(estimated.compensation.matrix).toEqual([[1, 0.2], [0.025, 1]]);
    expect(estimated.diagnostics).toMatchObject({
      channels: parameterNames,
      requestedChannels: detectorChannels,
    });
    expect(estimated.diagnostics.controls.map((control) => control.channel)).toEqual(parameterNames);
  });

  it("resolves detector aliases when channels is omitted and derived from controls", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-control-comp-alias-implicit-"));
    const unstainedPath = path.join(dir, "unstained.fcs");
    const fitcPath = path.join(dir, "fitc.fcs");
    const pePath = path.join(dir, "pe.fcs");
    // FCS files with $PnN=detector code, $PnS=parameter name — getParamNamesAuto picks $PnS as
    // the canonical name because both are complete/unique and $PnS takes precedence.
    await writeTinyIntegerFcs({
      fcsPath: unstainedPath,
      channels: ["FL03-A", "FL13-A"],
      markers: ["FITC-A", "PE-A"],
      rows: [[10, 20], [10, 20]],
    });
    await writeTinyIntegerFcs({
      fcsPath: fitcPath,
      channels: ["FL03-A", "FL13-A"],
      markers: ["FITC-A", "PE-A"],
      rows: [[110, 40], [110, 40]],
    });
    await writeTinyIntegerFcs({
      fcsPath: pePath,
      channels: ["FL03-A", "FL13-A"],
      markers: ["FITC-A", "PE-A"],
      rows: [[15, 220], [15, 220]],
    });
    // channels omitted — requestedChannels derived from controls[].channel
    const estimated = await estimateCompensationFromControls({
      unstainedPath,
      controls: [
        { path: fitcPath, channel: "FL03-A" },
        { path: pePath, channel: "FL13-A" },
      ],
    });
    expect(estimated.compensation.channels).toEqual(["FITC-A", "PE-A"]);
    expect(estimated.compensation.matrix).toEqual([[1, 0.2], [0.025, 1]]);
    expect(estimated.diagnostics.requestedChannels).toEqual(["FL03-A", "FL13-A"]);
    expect(estimated.diagnostics.controls.map((c) => c.channel)).toEqual(["FITC-A", "PE-A"]);
  });

  it("rejects missing or filename-only control-derived compensation mappings", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-control-comp-invalid-"));
    const controlPath = path.join(dir, "FITC_control.fcs");
    await writeTinyIntegerFcs({
      fcsPath: controlPath,
      channels: ["FITC-A", "PE-A"],
      rows: [[100, 20], [100, 20]],
    });
    await expect(estimateCompensationFromControls({
      channels: ["FITC-A", "PE-A"],
      controls: [{ path: controlPath, channel: "FITC-A" }],
    })).rejects.toMatchObject({ code: "missing_compensation_control" });
    await expect(estimateCompensationFromControls({
      channels: ["FITC-A"],
      controls: [{ path: controlPath, channel: "FITC_control.fcs" }],
    })).rejects.toMatchObject({ code: "unknown_compensation_control_channel" });
  });

  it("recovers correct spillover from mixed bead controls using primary_channel_top_percentile selection", async () => {
    // Validates the key failure mode from bead compensation live validation (2026-09-12):
    // when a single-stain bead file contains mixed negative/positive populations, the
    // all-event median can be dominated by background-level beads and give wrong spillover.
    // Bright-event selection isolates the positive population and recovers the correct value.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-bright-comp-"));
    const channels = ["FL1-A", "FL2-A"];
    const unstainedPath = path.join(dir, "unstained.fcs");
    const fl1Path = path.join(dir, "fl1.fcs");
    const fl2Path = path.join(dir, "fl2.fcs");

    // Unstained background: FL1=100, FL2=100
    await writeTinyIntegerFcs({ fcsPath: unstainedPath, channels, rows: Array(5).fill([100, 100]) });
    // FL1 control: 5 negative beads (FL1≈background, FL2=500 artifact) +
    //             5 positive beads (FL1=5000, FL2=590 = 0.1*(5000-100)+100, exact 10% spillover)
    await writeTinyIntegerFcs({
      fcsPath: fl1Path,
      channels,
      rows: [...Array(5).fill([150, 500]), ...Array(5).fill([5000, 590])],
    });
    // FL2 control: uniform positive (no mixed population needed here)
    await writeTinyIntegerFcs({ fcsPath: fl2Path, channels, rows: Array(5).fill([100, 10000]) });

    const controls = [
      { path: fl1Path, channel: "FL1-A" },
      { path: fl2Path, channel: "FL2-A" },
    ];

    // All-event median: negative bead artifact (FL2=500) contaminates the secondary median.
    // FL1 median of [150×5, 5000×5] = 2575; FL2 median of [500×5, 590×5] = 545.
    // Estimated FL1→FL2 spillover = (545-100)/(2575-100) ≈ 0.18, not 0.1.
    const allEvent = await estimateCompensationFromControls({ channels, unstainedPath, controls });
    expect(allEvent.compensation.matrix[0]![1]).not.toBeCloseTo(0.1, 1);

    // Bright-event selection (top 50%): selects the 5 positive bead events.
    // FL1 median = 5000; FL2 median = 590.
    // Estimated FL1→FL2 spillover = (590-100)/(5000-100) = 490/4900 = 0.1 exactly.
    const bright = await estimateCompensationFromControls({
      channels, unstainedPath, controls,
      eventSelection: { type: "primary_channel_top_percentile", percentile: 50 },
    });
    expect(bright.compensation.matrix[0]![1]).toBeCloseTo(0.1, 10);
    expect(bright.diagnostics.eventSelection).toMatchObject({ type: "primary_channel_top_percentile", percentile: 50 });
    expect(bright.diagnostics.controls[0]!.selectedEvents).toBe(5);
    expect(bright.diagnostics.controls[1]!.selectedEvents).toBeDefined();
  });

  it("rejects event_selection with out-of-range percentile", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-bright-comp-invalid-"));
    const controlPath = path.join(dir, "control.fcs");
    await writeTinyIntegerFcs({ fcsPath: controlPath, channels: ["FL1-A"], rows: [[100], [200]] });
    const controls = [{ path: controlPath, channel: "FL1-A" }];
    await expect(estimateCompensationFromControls({
      channels: ["FL1-A"],
      controls,
      eventSelection: { type: "primary_channel_top_percentile", percentile: 0 },
    })).rejects.toMatchObject({ code: "invalid_event_selection" });
    await expect(estimateCompensationFromControls({
      channels: ["FL1-A"],
      controls,
      eventSelection: { type: "primary_channel_top_percentile", percentile: 100 },
    })).rejects.toMatchObject({ code: "invalid_event_selection" });
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

  it("suggests a singlet gate without writing the workspace", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-singlet-"));
    const samplePath = path.join(dir, "sample.fcs");
    await writeTinyIntegerFcs({
      fcsPath: samplePath,
      channels: ["FSC-A", "FSC-H", "SSC-A"],
      rows: [
        [100, 52, 10],
        [200, 101, 12],
        [300, 151, 14],
        [400, 199, 16],
        [500, 251, 18],
      ],
    });
    const { workspacePath } = await initWorkspace({ rootDir: dir, samplePath, sampleId: "sample" });

    const result = await suggestSingletGate({ workspacePath, sampleId: "sample" });
    expect(result.ok).toBe(true);
    expect(result.gate).toMatchObject({
      sample: "sample",
      parent: "root",
      type: "polygon",
      x: "FSC-A",
      y: "FSC-H",
    });
    expect(result.gate.type).toBe("polygon");
    if (result.gate.type !== "polygon") throw new Error("Expected polygon singlet gate.");
    expect(result.gate.vertices).toHaveLength(4);
    expect(result.metrics.eventsUsed).toBe(5);
    expect(result.nextAction).toMatchObject({
      tool: "upsert_gate",
      arguments: { expected_revision: 0 },
    });
    expect((await readWorkspace(workspacePath)).gates).toEqual([]);
  });

  it("exportFlowJoWorkspace writes a coupled quadrant as four FlowJo rectangle populations", async () => {
    const { dir, workspacePath } = await makeWorkspace();
    await upsertGate({
      workspacePath,
      expectedRevision: 0,
      gate: {
        id: "quad",
        name: "Apoptosis",
        sample: "sample_001",
        parent: "root",
        type: "quadrant",
        x: "FSC-A",
        y: "SSC-A",
        xThreshold: 50,
        yThreshold: 60,
        quadrants: [
          { id: "quad_nn", name: "Viable", x: "-", y: "-" },
          { id: "quad_pn", name: "Early", x: "+", y: "-" },
          { id: "quad_pp", name: "Late", x: "+", y: "+" },
          { id: "quad_np", name: "Damaged", x: "-", y: "+" },
        ],
      },
    });
    const outputPath = path.join(path.dirname(workspacePath), "quadrant.wsp");
    await exportFlowJoWorkspace({ workspacePath, outputPath });
    const xml = await fs.readFile(outputPath, "utf8");
    expect(xml).not.toContain("gating:QuadrantGate");
    expect(xml).not.toContain('<Population name="Apoptosis"');
    expect(xml).toContain('<Population name="Viable"');
    expect(xml).toContain('<Population name="Early"');
    expect(xml).toContain('<Population name="Late"');
    expect(xml).toContain('<Population name="Damaged"');
    expect(xml).toMatch(/<Gate gating:id="quad_nn">[\s\S]*?<gating:dimension gating:max="50">[\s\S]*?name="FSC-A"[\s\S]*?<gating:dimension gating:max="60">[\s\S]*?name="SSC-A"/);
    expect(xml).toMatch(/<Gate gating:id="quad_pp">[\s\S]*?<gating:dimension gating:min="50">[\s\S]*?name="FSC-A"[\s\S]*?<gating:dimension gating:min="60">[\s\S]*?name="SSC-A"/);

    const importDir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-quadrant-roundtrip-"));
    const imported = await importFlowJoWorkspace({
      wspPath: outputPath,
      workspaceDir: importDir,
      samplePathMap: { "sample.fcs": path.join(dir, "data", "sample.fcs") },
    });
    const importedWorkspace = await readWorkspace(imported.workspacePath);
    const importedQuadrant = importedWorkspace.gates.find((gate) => gate.type === "quadrant");
    expect(importedQuadrant).toMatchObject({ type: "quadrant", xThreshold: 50, yThreshold: 60 });
    if (importedQuadrant?.type !== "quadrant") throw new Error("Expected imported FlowJo rectangle quartet to become a quadrant.");
    expect(importedQuadrant.quadrants.map((population) => `${population.x}${population.y}`)).toEqual(["--", "+-", "++", "-+"]);
    expect(importedQuadrant.quadrants.map((population) => population.name)).toEqual(["Viable", "Early", "Late", "Damaged"]);
  });

  it("exports marker-named gate axes as raw FCS detector dimensions", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-flowjo-detector-dimensions-"));
    const samplePath = path.join(dir, "sample.fcs");
    await writeTinyIntegerFcs({
      fcsPath: samplePath,
      channels: ["BL1-A", "BL3-A"],
      markers: ["Annexin X-FITC-A", "PI-PerCP-Cy5.5-A"],
      rows: [[10, 10], [80, 10], [80, 90], [10, 90]],
      extraKeywords: { "$FIL": "sample.with.dot.fcs", "$CYT": "Test Cytometer" },
    });
    const { workspacePath } = await initWorkspace({ rootDir: dir, samplePath, sampleId: "sample" });
    await upsertGate({
      workspacePath,
      expectedRevision: 0,
      gate: {
        id: "apoptosis",
        name: "Apoptosis",
        sample: "sample",
        parent: "root",
        type: "quadrant",
        x: "Annexin X-FITC-A",
        y: "PI-PerCP-Cy5.5-A",
        xThreshold: 50,
        yThreshold: 50,
        quadrants: [
          { id: "viable", name: "Viable", x: "-", y: "-" },
          { id: "early", name: "Early", x: "+", y: "-" },
          { id: "late", name: "Late", x: "+", y: "+" },
          { id: "damaged", name: "Damaged", x: "-", y: "+" },
        ],
      },
    });
    const outputPath = path.join(dir, "detectors.wsp");
    await exportFlowJoWorkspace({ workspacePath, outputPath });
    const xml = await fs.readFile(outputPath, "utf8");
    expect(xml).toContain('<data-type:fcs-dimension data-type:name="BL1-A"');
    expect(xml).toContain('<data-type:fcs-dimension data-type:name="BL3-A"');
    expect(xml).not.toContain('<data-type:fcs-dimension data-type:name="Annexin X-FITC-A"');
    expect(xml).not.toContain('<data-type:fcs-dimension data-type:name="PI-PerCP-Cy5.5-A"');
    expect(xml).toContain('<DataSet uri="file:/');
    expect(xml).not.toContain('keyword="$CYT"');
    expect(xml).toContain('<Keyword name="$FIL" value="sample.with.dot.fcs"');
    expect(xml).toContain('<Keyword name="$P1N" value="BL1-A"');
    expect(xml).toContain('<Keyword name="$P2N" value="BL3-A"');
    expect(xml).toContain('<SampleNode name="sample.with.dot.fcs"');
    expect(xml).toContain('<Transformations>');
    expect(xml).toMatch(/<transforms:linear[^>]*>[\s\S]*?<data-type:parameter data-type:name="BL1-A"/);
    expect(xml).not.toContain('gating:parent_id=""');

    const importDir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-flowjo-detector-roundtrip-"));
    const imported = await importFlowJoWorkspace({
      wspPath: outputPath,
      workspaceDir: importDir,
      samplePathMap: { "sample.fcs": samplePath },
    });
    const roundTrip = await readWorkspace(imported.workspacePath);
    const quadrant = roundTrip.gates.find((gate) => gate.type === "quadrant");
    expect(quadrant).toMatchObject({ x: "Annexin X-FITC-A", y: "PI-PerCP-Cy5.5-A" });
  });

  it("exports compensated fluorescence graphs and quadrant dimensions on matching Comp channels", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-flowjo-compensated-quadrant-"));
    const samplePath = path.join(dir, "sample.fcs");
    await writeTinyIntegerFcs({
      fcsPath: samplePath,
      channels: ["FSC-A", "SSC-A", "FSC-H", "BL1-A", "BL3-A"],
      markers: ["", "", "", "Annexin X-FITC-A", "PI-PerCP-Cy5.5-A"],
      rows: [[100, 100, 95, 10, 10], [100, 100, 95, 80, 10], [100, 100, 95, 80, 90], [100, 100, 95, 10, 90]],
    });
    const { workspacePath } = await initWorkspace({ rootDir: dir, samplePath, sampleId: "sample" });
    const hierarchy: WorkspaceGate[] = [
        {
          id: "main",
          name: "Main cells",
          sample: "sample",
          parent: "root",
          type: "rect",
          x: "FSC-A",
          y: "SSC-A",
          xMin: 0,
          xMax: 200,
          yMin: 0,
          yMax: 200,
        },
        {
          id: "singlets",
          name: "Suggested Singlets",
          sample: "sample",
          parent: "main",
          type: "rect",
          x: "FSC-A",
          y: "FSC-H",
          xMin: 0,
          xMax: 200,
          yMin: 0,
          yMax: 200,
        },
        {
        id: "apoptosis",
        name: "Apoptosis",
        sample: "sample",
        parent: "singlets",
        type: "quadrant",
        x: "BL1-A",
        y: "BL3-A",
        xThreshold: 50,
        yThreshold: 60,
        quadrants: [
          { id: "viable", name: "Viable", x: "-", y: "-" },
          { id: "early", name: "Early", x: "+", y: "-" },
          { id: "late", name: "Late", x: "+", y: "+" },
          { id: "damaged", name: "Damaged", x: "-", y: "+" },
        ],
      }];
    for (const [index, gate] of hierarchy.entries()) {
      const written = await upsertGate({ workspacePath, expectedRevision: index, gate });
      expect(written.ok, JSON.stringify(written)).toBe(true);
    }
    await upsertCompensationMatrix({
      workspacePath,
      expectedRevision: 3,
      compensation: {
        id: "derived_comp",
        name: "Derived compensation",
        source: "controls",
        channels: ["Annexin X-FITC-A", "PI-PerCP-Cy5.5-A"],
        matrix: [[1, 0.1], [0.001, 1]],
      },
    });
    const outputPath = path.join(dir, "compensated.wsp");
    const result = await exportFlowJoWorkspace({ workspacePath, outputPath, compensationId: "derived_comp" });
    expect(result.compensationExported).toBe(true);
    const xml = await fs.readFile(outputPath, "utf8");
    expect(xml).toContain('<data-type:parameter data-type:name="BL1-A" userProvidedCompInfix="Comp-BL1-A"');
    expect(xml).toContain('<transforms:coefficient data-type:parameter="BL3-A" transforms:value="0.1"');
    expect(xml).toMatch(/<SampleNode[^>]*>[\s\S]*?<Graph[^>]*>[\s\S]*?<Axis dimension="x" name="FSC-A"[\s\S]*?<Axis dimension="y" name="SSC-A"/);
    expect(xml).toMatch(/<Population name="Main cells"[\s\S]*?<Graph[^>]*>[\s\S]*?<Axis dimension="x" name="FSC-A"[\s\S]*?<Axis dimension="y" name="FSC-H"/);
    expect(xml).toMatch(/<Population name="Suggested Singlets"[\s\S]*?<Graph[^>]*>[\s\S]*?<Axis dimension="x" name="Comp-BL1-A"[\s\S]*?<Axis dimension="y" name="Comp-BL3-A"/);
    expect(xml).toContain('backColor="#ffffff"');
    expect(xml).toContain('foreColor="#000000"');
    expect(xml).toContain('heatMapStatParameter="Comp-BL1-A"');
    expect(xml).toContain('<GraphSettings level="5%"');
    expect(xml).toContain('showUncomped="0"');
    expect(xml).toMatch(/<Population name="Viable"[\s\S]*?<Graph[^>]*>[\s\S]*?<Axis dimension="x" name="Comp-BL1-A"[\s\S]*?<Axis dimension="y" name="Comp-BL3-A"/);
    expect(xml).toMatch(/<gating:dimension gating:max="50">\s*<data-type:fcs-dimension data-type:name="Comp-BL1-A"/);
    expect(xml).toMatch(/<gating:dimension gating:max="60">\s*<data-type:fcs-dimension data-type:name="Comp-BL3-A"/);
  });

  it("exportFlowJoWorkspace assigns distinct sequential sampleIDs for multi-sample workspaces", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-multisample-export-"));
    const sampleAPath = path.join(dir, "sampleA.fcs");
    const sampleBPath = path.join(dir, "sampleB.fcs");
    for (const fcsPath of [sampleAPath, sampleBPath]) {
      await writeTinyIntegerFcs({
        fcsPath,
        channels: ["FSC-A", "SSC-A"],
        rows: [[100, 200], [150, 250]],
      });
    }
    const { workspacePath, workspace } = await initWorkspace({ rootDir: dir, samplePath: sampleAPath, sampleId: "sampleA" });
    await writeWorkspace({
      workspacePath,
      workspace: {
        ...workspace,
        samples: [...workspace.samples, { id: "sampleB", path: path.relative(path.dirname(workspacePath), sampleBPath) }],
      },
      expectedRevision: workspace.revision,
    });
    const current = await readWorkspace(workspacePath);
    await upsertGates({
      workspacePath,
      expectedRevision: current.revision,
      gates: [
        { id: "gate_a", name: "Main A", sample: "sampleA", parent: "root", type: "rect", x: "FSC-A", y: "SSC-A", xMin: 50, xMax: 200, yMin: 50, yMax: 300 },
        { id: "gate_b", name: "Main B", sample: "sampleB", parent: "root", type: "rect", x: "FSC-A", y: "SSC-A", xMin: 50, xMax: 200, yMin: 50, yMax: 300 },
      ],
    });
    const outputPath = path.join(dir, "multi.wsp");
    const exported = await exportFlowJoWorkspace({ workspacePath, outputPath });
    expect(exported.samplesExported).toBe(2);
    const xml = await fs.readFile(outputPath, "utf8");
    expect(xml).toContain('sampleID="1"');
    expect(xml).toContain('sampleID="2"');
    // Both samples must have distinct DataSet entries; the second must not reuse "1"
    const sampleIdMatches = [...xml.matchAll(/sampleID="(\d+)"/g)].map((match) => match[1]);
    const uniqueIds = new Set(sampleIdMatches);
    expect(uniqueIds.size).toBeGreaterThanOrEqual(2);
    // Cytometers section must be present even when no non-linear views are defined
    expect(xml).toContain("<Cytometers>");
    expect(xml).toMatch(/<Cytometers>\s*<Cytometer name="Flowcyto" linearRescale="1"\s*\/>\s*<\/Cytometers>/);
    expect(xml).toContain('<GroupNode name="All Samples"');
    expect(xml).toContain('<Group name="All Samples"');
    expect(xml).toMatch(/<SampleRefs>[\s\S]*?<SampleRef sampleID="1"\s*\/>[\s\S]*?<SampleRef sampleID="2"\s*\/>[\s\S]*?<\/SampleRefs>/);
  });

  it("exportFlowJoWorkspace nests child-of-quadrant-population gate in Subpopulations", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-quadrant-child-export-"));
    const samplePath = path.join(dir, "sample.fcs");
    await writeTinyIntegerFcs({
      fcsPath: samplePath,
      channels: ["Annexin-A", "PI-A"],
      rows: [[10, 10], [80, 10], [80, 90], [10, 90]],
    });
    const { workspacePath } = await initWorkspace({ rootDir: dir, samplePath, sampleId: "sample" });
    await upsertGates({
      workspacePath,
      expectedRevision: 0,
      gates: [
        {
          id: "apoptosis",
          name: "Apoptosis",
          sample: "sample",
          parent: "root",
          type: "quadrant",
          x: "Annexin-A",
          y: "PI-A",
          xThreshold: 50,
          yThreshold: 50,
          quadrants: [
            { id: "viable", name: "Viable", x: "-", y: "-" },
            { id: "early", name: "Early", x: "+", y: "-" },
            { id: "late", name: "Late", x: "+", y: "+" },
            { id: "damaged", name: "Damaged", x: "-", y: "+" },
          ],
        },
        // This gate's parent is a quadrant population id (not the quadrant gate itself)
        { id: "late_bright", name: "Late Bright", sample: "sample", parent: "late", type: "range", x: "PI-A", min: 80, max: 100 },
      ],
    });
    const outputPath = path.join(dir, "child.wsp");
    await exportFlowJoWorkspace({ workspacePath, outputPath });
    const xml = await fs.readFile(outputPath, "utf8");
    // The Late Bright range gate must appear in the XML
    expect(xml).toContain('<Population name="Late Bright"');
    // It must be nested inside the matching FlowJo rectangle population.
    expect(xml).toMatch(/<Population name="Late"[\s\S]*?<Gate gating:id="late"[\s\S]*?<gating:RectangleGate[\s\S]*?<Population name="Late Bright"[\s\S]*?<gating:RangeGate/);
    // It must not appear before its quadrant population.
    const apoptosisPos = xml.indexOf('<Population name="Late"');
    const lateBrightPos = xml.indexOf('<Population name="Late Bright"');
    expect(lateBrightPos).toBeGreaterThan(apoptosisPos);

    // Round-trip: imported workspace must preserve the parent reference to the quadrant population
    const importDir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-quadrant-child-roundtrip-"));
    const imported = await importFlowJoWorkspace({
      wspPath: outputPath,
      workspaceDir: importDir,
      samplePathMap: { "sample.fcs": samplePath },
    });
    const importedWorkspace = await readWorkspace(imported.workspacePath);
    const lateBrightImported = importedWorkspace.gates.find((gate) => gate.id === "late_bright");
    expect(lateBrightImported?.parent).toBe("late");
  });

  it("returns exact population graph counts and percentages", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-popgraph-"));
    const samplePath = path.join(dir, "sample.fcs");
    await writeTinyIntegerFcs({
      fcsPath: samplePath,
      channels: ["FSC-A", "SSC-A", "FITC-A"],
      rows: [
        [10, 10, 1],
        [20, 20, 2],
        [30, 30, 10],
        [80, 80, 20],
      ],
    });
    const { workspacePath } = await initWorkspace({ rootDir: dir, samplePath, sampleId: "sample" });
    await upsertGates({
      workspacePath,
      expectedRevision: 0,
      gates: [
        {
          id: "main",
          name: "Main",
          sample: "sample",
          parent: "root",
          type: "rect",
          x: "FSC-A",
          y: "SSC-A",
          xMin: 0,
          xMax: 50,
          yMin: 0,
          yMax: 50,
        },
        {
          id: "fitc_positive",
          name: "FITC+",
          sample: "sample",
          parent: "main",
          type: "range",
          x: "FITC-A",
          min: 5,
          max: 30,
        },
      ],
    });

    const graph = await getPopulationGraph({ workspacePath, sampleId: "sample" });
    expect(graph).toMatchObject({
      ok: true,
      sampleId: "sample",
      revision: 1,
    });
    expect(graph.root).toMatchObject({
      gateId: "root",
      count: 4,
      percentOfRoot: 100,
    });
    const main = graph.root.children[0];
    expect(main).toMatchObject({
      gateId: "main",
      count: 3,
      percentOfParent: 75,
      percentOfRoot: 75,
    });
    expect(main?.children[0]).toMatchObject({
      gateId: "fitc_positive",
      count: 1,
      percentOfRoot: 25,
    });
    expect(main?.children[0]?.percentOfParent).toBeCloseTo(100 / 3);
  });

  it("applies explicit compensation before population graph and table counts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-pop-comp-"));
    const samplePath = path.join(dir, "sample.fcs");
    await writeTinyIntegerFcs({
      fcsPath: samplePath,
      channels: ["FITC-A", "PE-A"],
      rows: [
        [100, 20],  // compensated PE-A = 0 after FITC spillover removal
        [40, 8],    // compensated PE-A = 0 after FITC spillover removal
        [10, 90],
      ],
    });
    const { workspacePath, workspace } = await initWorkspace({ rootDir: dir, samplePath, sampleId: "sample" });
    await writeWorkspace({
      workspacePath,
      expectedRevision: workspace.revision,
      workspace: {
        ...workspace,
        compensations: [{
          id: "manual_comp",
          source: "manual",
          channels: ["FITC-A", "PE-A"],
          matrix: [
            [1, 0.2],
            [0, 1],
          ],
        }],
        gates: [{
          id: "pe_low",
          name: "PE low",
          sample: "sample",
          parent: "root",
          type: "range",
          x: "PE-A",
          min: -1,
          max: 5,
        }],
      },
    });

    const rawGraph = await getPopulationGraph({ workspacePath, sampleId: "sample" });
    expect(rawGraph.root.children[0]).toMatchObject({ gateId: "pe_low", count: 0 });

    const compensatedGraph = await getPopulationGraph({ workspacePath, sampleId: "sample", compensationId: "manual_comp" });
    expect(compensatedGraph.compensation).toMatchObject({
      applied: true,
      id: "manual_comp",
      channels: ["FITC-A", "PE-A"],
    });
    expect(compensatedGraph.root.children[0]).toMatchObject({ gateId: "pe_low", count: 2 });

    const table = await getPopulationTable({ workspacePath, compensationId: "manual_comp" });
    expect(table.compensationId).toBe("manual_comp");
    expect(table.rows[0]!.gates["pe_low"]).toMatchObject({ gateId: "pe_low", count: 2 });

    // Unknown compensation_id throws
    await expect(
      getPopulationGraph({ workspacePath, sampleId: "sample", compensationId: "nonexistent" }),
    ).rejects.toMatchObject({ code: "unknown_compensation" });
  });

  it("returns population table across multiple samples", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-poptable-multi-"));
    // Two samples with identical channel layout but different event distributions
    const sampleAPath = path.join(dir, "sampleA.fcs");
    const sampleBPath = path.join(dir, "sampleB.fcs");
    await writeTinyIntegerFcs({
      fcsPath: sampleAPath,
      channels: ["FITC-A", "PE-A"],
      rows: [[5, 5], [50, 5], [50, 5], [5, 80]],  // 2 FITC+, 1 PE+, 1 double-neg
    });
    await writeTinyIntegerFcs({
      fcsPath: sampleBPath,
      channels: ["FITC-A", "PE-A"],
      rows: [[5, 5], [5, 5], [50, 5], [50, 80]],  // 1 FITC+, 0 PE-only, 1 double-pos
    });
    const { workspacePath, workspace } = await initWorkspace({ rootDir: dir, samplePath: sampleAPath, sampleId: "A" });
    // Add sample B to the workspace
    await writeWorkspace({
      workspacePath,
      workspace: { ...workspace, samples: [...workspace.samples, { id: "B", path: path.relative(path.dirname(workspacePath), sampleBPath) }] },
      expectedRevision: workspace.revision,
    });
    // Add range gates for both samples with shared IDs
    const ws = await readWorkspace(workspacePath);
    await upsertGates({
      workspacePath,
      expectedRevision: ws.revision,
      gates: [
        { id: "fitc_pos", name: "FITC+", sample: "A", parent: "root", type: "range", x: "FITC-A", min: 20, max: 200 },
        { id: "pe_pos",   name: "PE+",   sample: "A", parent: "root", type: "range", x: "PE-A",   min: 20, max: 200 },
        { id: "fitc_pos_b", name: "FITC+", sample: "B", parent: "root", type: "range", x: "FITC-A", min: 20, max: 200 },
        { id: "pe_pos_b",   name: "PE+",   sample: "B", parent: "root", type: "range", x: "PE-A",   min: 20, max: 200 },
      ],
    });

    const table = await getPopulationTable({ workspacePath });
    expect(table.ok).toBe(true);
    expect(table.columnKey).toBe("gate_id");
    expect(table.rows).toHaveLength(2);
    expect(table.rows.map((r) => r.sampleId)).toEqual(["A", "B"]);
    // Sample A: 2/4 FITC+, 1/4 PE+; cell carries gateId for provenance
    const rowA = table.rows[0]!;
    expect(rowA.gates["fitc_pos"]).toMatchObject({ gateId: "fitc_pos", count: 2, percentOfRoot: 50 });
    expect(rowA.gates["pe_pos"]).toMatchObject({ gateId: "pe_pos", count: 1, percentOfRoot: 25 });
    // Sample B: 2/4 FITC+, 1/4 PE+; gate_id mode — separate columns per sample
    const rowB = table.rows[1]!;
    expect(rowB.gates["fitc_pos_b"]).toMatchObject({ gateId: "fitc_pos_b", count: 2, percentOfRoot: 50 });
    expect(rowB.gates["pe_pos_b"]).toMatchObject({ gateId: "pe_pos_b", count: 1, percentOfRoot: 25 });
    // In gate_id mode, same-named gates on different samples are separate columns
    expect(table.columns).toHaveLength(4);
  });

  it("aligns same-named gates across samples using name_path column key", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-poptable-namepath-"));
    const sampleAPath = path.join(dir, "sampleA.fcs");
    const sampleBPath = path.join(dir, "sampleB.fcs");
    await writeTinyIntegerFcs({
      fcsPath: sampleAPath,
      channels: ["Annexin-A", "PI-A"],
      rows: [[5, 5], [80, 5], [80, 90], [5, 90]],  // 1 Q1, 1 Q2, 1 Q3, 1 Q4
    });
    await writeTinyIntegerFcs({
      fcsPath: sampleBPath,
      channels: ["Annexin-A", "PI-A"],
      rows: [[5, 5], [5, 5], [80, 5], [80, 5]],  // 2 Q1, 2 Q2, 0 Q3, 0 Q4
    });
    const { workspacePath, workspace } = await initWorkspace({ rootDir: dir, samplePath: sampleAPath, sampleId: "A" });
    await writeWorkspace({
      workspacePath,
      workspace: { ...workspace, samples: [...workspace.samples, { id: "B", path: path.relative(path.dirname(workspacePath), sampleBPath) }] },
      expectedRevision: workspace.revision,
    });
    const ws = await readWorkspace(workspacePath);
    // Each sample has its own gate IDs, but gates share the same name at the same hierarchy level
    await upsertGates({
      workspacePath,
      expectedRevision: ws.revision,
      gates: [
        { id: "q1_a", name: "Q1 Annexin-/PI-", sample: "A", parent: "root", type: "rect", x: "Annexin-A", y: "PI-A", xMin: 0, xMax: 50, yMin: 0,  yMax: 50 },
        { id: "q2_a", name: "Q2 Annexin+/PI-", sample: "A", parent: "root", type: "rect", x: "Annexin-A", y: "PI-A", xMin: 50, xMax: 200, yMin: 0,  yMax: 50 },
        { id: "q3_a", name: "Q3 Annexin+/PI+", sample: "A", parent: "root", type: "rect", x: "Annexin-A", y: "PI-A", xMin: 50, xMax: 200, yMin: 50, yMax: 200 },
        { id: "q4_a", name: "Q4 Annexin-/PI+", sample: "A", parent: "root", type: "rect", x: "Annexin-A", y: "PI-A", xMin: 0,  xMax: 50, yMin: 50, yMax: 200 },
        { id: "q1_b", name: "Q1 Annexin-/PI-", sample: "B", parent: "root", type: "rect", x: "Annexin-A", y: "PI-A", xMin: 0, xMax: 50, yMin: 0,  yMax: 50 },
        { id: "q2_b", name: "Q2 Annexin+/PI-", sample: "B", parent: "root", type: "rect", x: "Annexin-A", y: "PI-A", xMin: 50, xMax: 200, yMin: 0,  yMax: 50 },
        { id: "q3_b", name: "Q3 Annexin+/PI+", sample: "B", parent: "root", type: "rect", x: "Annexin-A", y: "PI-A", xMin: 50, xMax: 200, yMin: 50, yMax: 200 },
        { id: "q4_b", name: "Q4 Annexin-/PI+", sample: "B", parent: "root", type: "rect", x: "Annexin-A", y: "PI-A", xMin: 0,  xMax: 50, yMin: 50, yMax: 200 },
      ],
    });

    const table = await getPopulationTable({ workspacePath, columnKey: "name_path" });
    expect(table.columnKey).toBe("name_path");
    // name_path merges same-named root-level gates → 4 logical columns, not 8
    expect(table.columns).toHaveLength(4);
    expect(table.columns.map((c) => c.key)).toEqual([
      "Q1 Annexin-/PI-", "Q2 Annexin+/PI-", "Q3 Annexin+/PI+", "Q4 Annexin-/PI+",
    ]);
    // Each cell carries the sample-specific gateId for provenance
    expect(table.rows[0]!.gates["Q1 Annexin-/PI-"]).toMatchObject({ gateId: "q1_a", count: 1 });
    expect(table.rows[1]!.gates["Q1 Annexin-/PI-"]).toMatchObject({ gateId: "q1_b", count: 2 });
    expect(table.rows[0]!.gates["Q3 Annexin+/PI+"]).toMatchObject({ gateId: "q3_a", count: 1 });
    expect(table.rows[1]!.gates["Q3 Annexin+/PI+"]).toMatchObject({ gateId: "q3_b", count: 0 });
  });

  it("filters population table by sample_ids and gate_ids", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-poptable-filter-"));
    const sampleAPath = path.join(dir, "sampleA.fcs");
    const sampleBPath = path.join(dir, "sampleB.fcs");
    await writeTinyIntegerFcs({ fcsPath: sampleAPath, channels: ["FITC-A"], rows: [[5], [50], [50]] });
    await writeTinyIntegerFcs({ fcsPath: sampleBPath, channels: ["FITC-A"], rows: [[5], [5], [50]] });
    const { workspacePath, workspace } = await initWorkspace({ rootDir: dir, samplePath: sampleAPath, sampleId: "A" });
    await writeWorkspace({
      workspacePath,
      workspace: { ...workspace, samples: [...workspace.samples, { id: "B", path: path.relative(path.dirname(workspacePath), sampleBPath) }] },
      expectedRevision: workspace.revision,
    });
    const ws = await readWorkspace(workspacePath);
    await upsertGates({
      workspacePath,
      expectedRevision: ws.revision,
      gates: [
        { id: "fitc_a", name: "FITC+", sample: "A", parent: "root", type: "range", x: "FITC-A", min: 20, max: 200 },
        { id: "fitc_b", name: "FITC+", sample: "B", parent: "root", type: "range", x: "FITC-A", min: 20, max: 200 },
      ],
    });

    // Filter to sample A only, gate fitc_a only
    const filtered = await getPopulationTable({ workspacePath, sampleIds: ["A"], gateIds: ["fitc_a"] });
    expect(filtered.rows).toHaveLength(1);
    expect(filtered.rows[0]!.sampleId).toBe("A");
    expect(filtered.rows[0]!.gates["fitc_a"]).toMatchObject({ gateId: "fitc_a", count: 2 });
    expect(Object.keys(filtered.rows[0]!.gates)).toEqual(["fitc_a"]);
    expect(filtered.columns).toHaveLength(1);
    expect(filtered.columns[0]!.key).toBe("fitc_a");

    // Gate from another sample returns null for sample A's row (gate_id mode)
    const crossSample = await getPopulationTable({ workspacePath, gateIds: ["fitc_a", "fitc_b"] });
    expect(crossSample.rows).toHaveLength(2);
    expect(crossSample.rows[0]!.gates["fitc_b"]).toBeNull();  // fitc_b not in sample A
    expect(crossSample.rows[1]!.gates["fitc_a"]).toBeNull();  // fitc_a not in sample B

    // gate_ids filter works in name_path mode too: filters to those gate IDs then groups by path
    const namePathFiltered = await getPopulationTable({
      workspacePath,
      gateIds: ["fitc_a", "fitc_b"],
      columnKey: "name_path",
    });
    // Both gates have name "FITC+" at root level → one logical column
    expect(namePathFiltered.columns).toHaveLength(1);
    expect(namePathFiltered.columns[0]!.key).toBe("FITC+");
    expect(namePathFiltered.rows[0]!.gates["FITC+"]).toMatchObject({ gateId: "fitc_a", count: 2 });
    expect(namePathFiltered.rows[1]!.gates["FITC+"]).toMatchObject({ gateId: "fitc_b", count: 1 });
  });

  it("rejects population table request with unknown sample_id", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-poptable-err-"));
    const samplePath = path.join(dir, "sample.fcs");
    await writeTinyIntegerFcs({ fcsPath: samplePath, channels: ["FITC-A"], rows: [[5], [50]] });
    const { workspacePath } = await initWorkspace({ rootDir: dir, samplePath, sampleId: "A" });
    await expect(
      getPopulationTable({ workspacePath, sampleIds: ["NONEXISTENT"] }),
    ).rejects.toMatchObject({ code: "unknown_sample" });
  });

  it("suggests apoptosis quadrants from manual thresholds without writing the workspace", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-apoptosis-manual-"));
    const samplePath = path.join(dir, "sample.fcs");
    await writeTinyIntegerFcs({
      fcsPath: samplePath,
      channels: ["Annexin-A", "PI-A"],
      rows: [
        [10, 10],
        [80, 10],
        [80, 90],
        [10, 90],
      ],
    });
    const { workspacePath } = await initWorkspace({ rootDir: dir, samplePath, sampleId: "sample" });

    const result = await suggestApoptosisQuadrants({
      workspacePath,
      sampleId: "sample",
      annexinChannel: "Annexin-A",
      deathChannel: "PI-A",
      thresholdMethod: "manual",
      manualAnnexinThreshold: 50,
      manualDeathThreshold: 50,
    });
    expect(result.ok).toBe(true);
    expect(result.thresholds).toMatchObject({ annexin: 50, death: 50, source: "manual" });
    expect(result.diagnostics.confidence).toBe("manual_thresholds");
    expect(result.diagnostics.compensation.applied).toBe(false);
    expect(result.gate).toMatchObject({
      type: "quadrant",
      parent: "root",
      xThreshold: 50,
      yThreshold: 50,
    });
    expect(result.gate.quadrants).toHaveLength(4);
    expect(new Set(result.gate.quadrants.map((population) => `${population.x}${population.y}`))).toEqual(new Set(["--", "+-", "++", "-+"]));
    expect(result.summary).toMatchObject({
      viable: { count: 1, percentOfParent: 25 },
      earlyApoptotic: { count: 1, percentOfParent: 25 },
      lateApoptoticDead: { count: 1, percentOfParent: 25 },
      necroticOrMembraneDamaged: { count: 1, percentOfParent: 25 },
    });
    expect(result.nextAction).toMatchObject({
      tool: "upsert_gate",
      arguments: { expected_revision: 0 },
    });
    expect((await readWorkspace(workspacePath)).gates).toEqual([]);

    const written = await upsertGate({ workspacePath, gate: result.gate, expectedRevision: 0 });
    expect(written.ok).toBe(true);
    const graph = await getPopulationGraph({ workspacePath, sampleId: "sample" });
    expect(Object.fromEntries(graph.root.children.map((node) => [node.gateId, node.count]))).toEqual(
      Object.fromEntries(result.gate.quadrants.map((population) => [population.id, 1])),
    );
    const viablePreview = await getEventPreview({
      workspacePath,
      sampleId: "sample",
      parent: result.gate.quadrants[0].id,
      x: "Annexin-A",
      y: "PI-A",
    });
    expect(viablePreview.filteredEvents).toBe(1);
    const table = await getPopulationTable({
      workspacePath,
      sampleIds: ["sample"],
      gateIds: result.gate.quadrants.map((population) => population.id),
    });
    expect(table.columns).toHaveLength(4);
    expect(Object.values(table.rows[0]!.gates).map((cell) => cell?.count)).toEqual([1, 1, 1, 1]);
  });

  it("anchors apoptosis thresholds to a negative control percentile", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-apoptosis-negative-"));
    const samplePath = path.join(dir, "sample.fcs");
    const negativePath = path.join(dir, "negative.fcs");
    await writeTinyIntegerFcs({
      fcsPath: samplePath,
      channels: ["Annexin-A", "PI-A"],
      rows: [
        [1, 1],
        [10, 2],
        [20, 20],
        [2, 30],
      ],
    });
    await writeTinyIntegerFcs({
      fcsPath: negativePath,
      channels: ["Annexin-A", "PI-A"],
      rows: [
        [1, 2],
        [3, 4],
        [5, 6],
      ],
    });
    const { workspacePath } = await initWorkspace({ rootDir: dir, samplePath, sampleId: "sample" });

    const result = await suggestApoptosisQuadrants({
      workspacePath,
      sampleId: "sample",
      annexinChannel: "Annexin-A",
      deathChannel: "PI-A",
      negativeControl: { fcsPath: negativePath },
      negativePercentile: 50,
    });
    expect(result.thresholds).toMatchObject({
      annexin: 3,
      death: 4,
      source: "negative_control",
      negativePercentile: 50,
    });
    expect(result.diagnostics.confidence).toBe("control_anchored");
    expect(result.diagnostics.controls.negative).toEqual({ events: 3 });
    expect(result.summary.viable.count).toBe(1);
    expect(result.summary.earlyApoptotic.count).toBe(1);
    expect(result.summary.lateApoptoticDead.count).toBe(1);
    expect(result.summary.necroticOrMembraneDamaged.count).toBe(1);
  });

  it("applies apoptosis compensation through detector-to-parameter channel alignment", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-apoptosis-comp-"));
    const samplePath = path.join(dir, "sample.fcs");
    await writeTinyIntegerFcs({
      fcsPath: samplePath,
      channels: ["BL1-A", "BL3-A"],
      markers: ["Annexin-A", "PI-A"],
      rows: [
        [10, 10],
        [80, 10],
      ],
      extraKeywords: {
        $SPILLOVER: "2,BL1-A,BL3-A,1,0.1,0.2,1",
      },
    });
    const opened = await openFcsArtifact({ path: samplePath, workspaceDir: dir, sampleId: "sample" });
    const workspace = await readWorkspace(opened.workspacePath);
    const compensation = workspace.compensations?.[0];
    expect(compensation?.channels).toEqual(["BL1-A", "BL3-A"]);

    const result = await suggestApoptosisQuadrants({
      workspacePath: opened.workspacePath,
      sampleId: "sample",
      annexinChannel: "Annexin-A",
      deathChannel: "PI-A",
      thresholdMethod: "manual",
      manualAnnexinThreshold: 50,
      manualDeathThreshold: 50,
      compensationId: compensation?.id,
    });
    expect(result.diagnostics.compensation).toMatchObject({
      applied: true,
      id: compensation?.id,
      channels: ["Annexin-A", "PI-A"],
    });
  });

  it("marks apoptosis quadrant suggestions exploratory when controls are missing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-apoptosis-exploratory-"));
    const samplePath = path.join(dir, "sample.fcs");
    await writeTinyIntegerFcs({
      fcsPath: samplePath,
      channels: ["Annexin-A", "PI-A"],
      rows: [[1, 1], [2, 2], [100, 100]],
    });
    const { workspacePath } = await initWorkspace({ rootDir: dir, samplePath, sampleId: "sample" });

    const result = await suggestApoptosisQuadrants({
      workspacePath,
      sampleId: "sample",
      annexinChannel: "Annexin-A",
      deathChannel: "PI-A",
    });
    expect(result.thresholds.source).toBe("exploratory");
    expect(result.diagnostics.confidence).toBe("exploratory");
    expect(result.diagnostics.warnings.join(" ")).toContain("No negative control or manual thresholds");
  });

  it("rejects apoptosis suggestion when a requested channel is not present in the FCS file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-apoptosis-missing-ch-"));
    const samplePath = path.join(dir, "sample.fcs");
    await writeTinyIntegerFcs({
      fcsPath: samplePath,
      channels: ["Annexin-A", "PI-A"],
      rows: [[10, 10]],
    });
    const { workspacePath } = await initWorkspace({ rootDir: dir, samplePath, sampleId: "sample" });

    await expect(suggestApoptosisQuadrants({
      workspacePath,
      sampleId: "sample",
      annexinChannel: "Annexin-A",
      deathChannel: "NotAChannel",
      thresholdMethod: "manual",
      manualAnnexinThreshold: 50,
      manualDeathThreshold: 50,
    })).rejects.toMatchObject({ code: "unknown_parameter" });
  });

  it("upsertGates creates multiple gates in one revision increment", async () => {
    const { workspacePath } = await makeWorkspace();
    const gates: WorkspaceGate[] = [
      { id: "q1", name: "Q1", sample: "sample_001", parent: "root", type: "rect", x: "FSC-A", y: "SSC-A", xMin: 0, xMax: 50, yMin: 50, yMax: 100 },
      { id: "q2", name: "Q2", sample: "sample_001", parent: "root", type: "rect", x: "FSC-A", y: "SSC-A", xMin: 50, xMax: 100, yMin: 50, yMax: 100 },
      { id: "q3", name: "Q3", sample: "sample_001", parent: "root", type: "rect", x: "FSC-A", y: "SSC-A", xMin: 0, xMax: 50, yMin: 0, yMax: 50 },
      { id: "q4", name: "Q4", sample: "sample_001", parent: "root", type: "rect", x: "FSC-A", y: "SSC-A", xMin: 50, xMax: 100, yMin: 0, yMax: 50 },
    ];
    const result = await upsertGates({ workspacePath, gates, expectedRevision: 0 });
    expect(result.ok).toBe(true);
    expect(result.revision).toBe(1);
    expect(result.gateCount).toBe(4);
    const workspace = await readWorkspace(workspacePath);
    expect(workspace.gates).toHaveLength(4);
    expect(workspace.revision).toBe(1);
  });

  it("upsertGates updates existing gates by ID and appends new ones in one write", async () => {
    const { workspacePath } = await makeWorkspace();
    await upsertGate({ workspacePath, gate: testGate(), expectedRevision: 0 });
    const updated: WorkspaceGate = { ...testGate(), name: "Renamed" };
    const newGate: WorkspaceGate = { id: "gate_2", name: "New", sample: "sample_001", parent: "root", type: "rect", x: "FSC-A", y: "SSC-A", xMin: 10, xMax: 90, yMin: 10, yMax: 90 };
    const result = await upsertGates({ workspacePath, gates: [updated, newGate], expectedRevision: 1 });
    expect(result.ok).toBe(true);
    expect(result.revision).toBe(2);
    expect(result.gateCount).toBe(2);
    const workspace = await readWorkspace(workspacePath);
    expect(workspace.gates.find((g) => g.id === "gate_1")?.name).toBe("Renamed");
    expect(workspace.gates.find((g) => g.id === "gate_2")?.name).toBe("New");
  });

  it("upsertGates rejects stale revision", async () => {
    const { workspacePath } = await makeWorkspace();
    await upsertGate({ workspacePath, gate: testGate(), expectedRevision: 0 });
    const result = await upsertGates({
      workspacePath,
      gates: [{ id: "q1", name: "Q1", sample: "sample_001", parent: "root", type: "rect", x: "FSC-A", y: "SSC-A", xMin: 0, xMax: 50, yMin: 0, yMax: 50 }],
      expectedRevision: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]?.code).toBe("stale_revision");
    expect((await readWorkspace(workspacePath)).gates).toHaveLength(1);
  });

  it("propagates a gate hierarchy to target samples with deterministic ids", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-propagate-gates-"));
    const sampleAPath = path.join(dir, "sampleA.fcs");
    const sampleBPath = path.join(dir, "sampleB.fcs");
    const sampleCPath = path.join(dir, "sampleC.fcs");
    for (const fcsPath of [sampleAPath, sampleBPath, sampleCPath]) {
      await writeTinyIntegerFcs({
        fcsPath,
        channels: ["FSC-A", "SSC-A", "FITC-A"],
        rows: [[10, 10, 5], [50, 50, 80], [90, 90, 120]],
      });
    }
    const { workspacePath, workspace } = await initWorkspace({ rootDir: dir, samplePath: sampleAPath, sampleId: "A" });
    await writeWorkspace({
      workspacePath,
      workspace: {
        ...workspace,
        samples: [
          ...workspace.samples,
          { id: "B", path: path.relative(path.dirname(workspacePath), sampleBPath) },
          { id: "C", path: path.relative(path.dirname(workspacePath), sampleCPath) },
        ],
      },
      expectedRevision: workspace.revision,
    });
    const ws = await readWorkspace(workspacePath);
    await upsertGates({
      workspacePath,
      expectedRevision: ws.revision,
      gates: [
        { id: "lymph", name: "Lymphocytes", sample: "A", parent: "root", type: "rect", x: "FSC-A", y: "SSC-A", xMin: 0, xMax: 100, yMin: 0, yMax: 100 },
        { id: "fitc_pos", name: "FITC+", sample: "A", parent: "lymph", type: "range", x: "FITC-A", min: 50, max: 200 },
      ],
    });
    const beforePropagate = await readWorkspace(workspacePath);

    const result = await propagateGates({
      workspacePath,
      sourceGateIds: ["lymph", "fitc_pos"],
      targetSampleIds: ["B", "C"],
      expectedRevision: beforePropagate.revision,
    });

    expect(result.ok).toBe(true);
    expect(result.propagatedCount).toBe(4);
    expect(result.gates?.map((gate) => gate.id)).toEqual(["lymph__B", "fitc_pos__B", "lymph__C", "fitc_pos__C"]);
    const propagatedWorkspace = await readWorkspace(workspacePath);
    expect(propagatedWorkspace.gates.find((gate) => gate.id === "fitc_pos__B")).toMatchObject({
      sample: "B",
      parent: "lymph__B",
      name: "FITC+",
    });
    const table = await getPopulationTable({ workspacePath, sampleIds: ["A", "B", "C"], columnKey: "name_path" });
    expect(table.columns.map((column) => column.key)).toEqual(["Lymphocytes", "Lymphocytes / FITC+"]);
    expect(table.rows[1]?.gates["Lymphocytes / FITC+"]?.gateId).toBe("fitc_pos__B");
    expect(table.rows[2]?.gates["Lymphocytes / FITC+"]?.gateId).toBe("fitc_pos__C");
  });

  it("propagates quadrant population ids and downstream parent references", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-propagate-quadrant-"));
    const sampleAPath = path.join(dir, "sampleA.fcs");
    const sampleBPath = path.join(dir, "sampleB.fcs");
    for (const fcsPath of [sampleAPath, sampleBPath]) {
      await writeTinyIntegerFcs({
        fcsPath,
        channels: ["Annexin-A", "PI-A"],
        rows: [[10, 10], [80, 10], [80, 90], [10, 90]],
      });
    }
    const { workspacePath, workspace } = await initWorkspace({ rootDir: dir, samplePath: sampleAPath, sampleId: "A" });
    await writeWorkspace({
      workspacePath,
      workspace: { ...workspace, samples: [...workspace.samples, { id: "B", path: path.relative(path.dirname(workspacePath), sampleBPath) }] },
      expectedRevision: workspace.revision,
    });
    const current = await readWorkspace(workspacePath);
    await upsertGates({
      workspacePath,
      expectedRevision: current.revision,
      gates: [
        {
          id: "apoptosis",
          name: "Apoptosis",
          sample: "A",
          parent: "root",
          type: "quadrant",
          x: "Annexin-A",
          y: "PI-A",
          xThreshold: 50,
          yThreshold: 50,
          quadrants: [
            { id: "viable", name: "Viable", x: "-", y: "-" },
            { id: "early", name: "Early", x: "+", y: "-" },
            { id: "late", name: "Late", x: "+", y: "+" },
            { id: "damaged", name: "Damaged", x: "-", y: "+" },
          ],
        },
        { id: "late_high", name: "Late high", sample: "A", parent: "late", type: "range", x: "PI-A", min: 80, max: 100 },
      ],
    });
    const before = await readWorkspace(workspacePath);
    const result = await propagateGates({
      workspacePath,
      sourceGateIds: ["apoptosis", "late_high"],
      targetSampleIds: ["B"],
      expectedRevision: before.revision,
    });
    expect(result.ok).toBe(true);
    const propagated = await readWorkspace(workspacePath);
    const quadrant = propagated.gates.find((gate) => gate.id === "apoptosis__B");
    if (quadrant?.type !== "quadrant") throw new Error("Expected propagated quadrant gate.");
    expect(quadrant.quadrants.map((population) => population.id)).toEqual(["viable__B", "early__B", "late__B", "damaged__B"]);
    expect(propagated.gates.find((gate) => gate.id === "late_high__B")?.parent).toBe("late__B");
    const graph = await getPopulationGraph({ workspacePath, sampleId: "B" });
    const late = graph.root.children.find((node) => node.gateId === "late__B");
    expect(late?.count).toBe(1);
    expect(late?.children[0]).toMatchObject({ gateId: "late_high__B", count: 1 });
  });

  it("classifies quadrant events using compensated channel values", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-quadrant-comp-eval-"));
    const samplePath = path.join(dir, "sample.fcs");
    // Annexin-A spills into PI-A at 90% (extreme spillover so the effect is unambiguous).
    // Event [60, 55]: raw PI=55 > threshold 50 (PI+), compensated PI = 55 - 0.9×60 = 1 < 50 (PI-).
    // Without compensation the event falls in the late-apoptotic quadrant (Annexin+/PI+).
    // With compensation it moves to early-apoptotic (Annexin+/PI-).
    //
    // The $SPILLOVER matrix is stored in transposed orientation relative to the standard
    // FCS column-vector convention: the code uses observed × S⁻¹ (row-vector form), so
    // S[row=Annexin][col=PI]=0.9 encodes "PI is removed from the Annexin channel during
    // compensation". To encode "Annexin spills into PI", the 0.9 goes at S[row=Annexin][col=PI]
    // in the transposed-storage sense, i.e., the matrix string is "1,0.9,0,1" not "1,0,0.9,1".
    await writeTinyIntegerFcs({
      fcsPath: samplePath,
      channels: ["Annexin-A", "PI-A"],
      rows: [
        [60, 55], // moves quadrants after compensation
        [10, 10], // viable in both cases
      ],
      extraKeywords: { $SPILLOVER: "2,Annexin-A,PI-A,1,0.9,0,1" },
    });
    const opened = await openFcsArtifact({ path: samplePath, workspaceDir: dir, sampleId: "sample" });
    const workspace = await readWorkspace(opened.workspacePath);
    const compId = workspace.compensations?.[0]?.id;
    expect(compId).toBeDefined();

    await upsertGate({
      workspacePath: opened.workspacePath,
      gate: {
        id: "apoptosis",
        name: "Apoptosis",
        sample: "sample",
        parent: "root",
        type: "quadrant",
        x: "Annexin-A",
        y: "PI-A",
        xThreshold: 50,
        yThreshold: 50,
        quadrants: [
          { id: "viable", name: "Viable", x: "-", y: "-" },
          { id: "early", name: "Early", x: "+", y: "-" },
          { id: "late", name: "Late", x: "+", y: "+" },
          { id: "damaged", name: "Damaged", x: "-", y: "+" },
        ],
      },
      expectedRevision: workspace.revision,
    });

    const toCount = (graph: Awaited<ReturnType<typeof getPopulationGraph>>) =>
      Object.fromEntries(graph.root.children.map((n) => [n.gateId, n.count]));

    const raw = toCount(await getPopulationGraph({ workspacePath: opened.workspacePath, sampleId: "sample" }));
    expect(raw["late"]).toBe(1);  // [60,55] is Annexin+/PI+ without compensation
    expect(raw["early"]).toBe(0);

    const comp = toCount(await getPopulationGraph({ workspacePath: opened.workspacePath, sampleId: "sample", compensationId: compId }));
    expect(comp["early"]).toBe(1); // [60,55] moves to Annexin+/PI- after compensation
    expect(comp["late"]).toBe(0);
    expect(comp["viable"]).toBe(1); // [10,10] is unaffected
  });

  it("aligns propagated quadrant populations by name path in population table", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-table-namepath-"));
    const sampleAPath = path.join(dir, "sampleA.fcs");
    const sampleBPath = path.join(dir, "sampleB.fcs");
    // Sample A: 2 viable, 1 early apoptotic.  Sample B: 1 viable, 2 early apoptotic.
    await writeTinyIntegerFcs({ fcsPath: sampleAPath, channels: ["Annexin-A", "PI-A"], rows: [[10, 10], [10, 10], [80, 10]] });
    await writeTinyIntegerFcs({ fcsPath: sampleBPath, channels: ["Annexin-A", "PI-A"], rows: [[10, 10], [80, 10], [80, 10]] });

    const { workspacePath, workspace } = await initWorkspace({ rootDir: dir, samplePath: sampleAPath, sampleId: "A" });
    await writeWorkspace({
      workspacePath,
      workspace: { ...workspace, samples: [...workspace.samples, { id: "B", path: path.relative(path.dirname(workspacePath), sampleBPath) }] },
      expectedRevision: workspace.revision,
    });
    const current = await readWorkspace(workspacePath);
    await upsertGates({
      workspacePath,
      expectedRevision: current.revision,
      gates: [{
        id: "apoptosis",
        name: "Apoptosis",
        sample: "A",
        parent: "root",
        type: "quadrant",
        x: "Annexin-A",
        y: "PI-A",
        xThreshold: 50,
        yThreshold: 50,
        quadrants: [
          { id: "viable", name: "Viable", x: "-", y: "-" },
          { id: "early", name: "Early Apoptotic", x: "+", y: "-" },
          { id: "late", name: "Late Apoptotic", x: "+", y: "+" },
          { id: "damaged", name: "Damaged", x: "-", y: "+" },
        ],
      }],
    });
    const before = await readWorkspace(workspacePath);
    await propagateGates({ workspacePath, sourceGateIds: ["apoptosis"], targetSampleIds: ["B"], expectedRevision: before.revision });

    const table = await getPopulationTable({ workspacePath, sampleIds: ["A", "B"], columnKey: "name_path" });

    const viableCol = table.columns.find((col) => col.name === "Viable");
    const earlyCol = table.columns.find((col) => col.name === "Early Apoptotic");
    expect(viableCol).toBeDefined();
    expect(earlyCol).toBeDefined();

    const rowA = table.rows.find((r) => r.sampleId === "A");
    expect(rowA?.gates[viableCol!.key]?.count).toBe(2);
    expect(rowA?.gates[earlyCol!.key]?.count).toBe(1);

    const rowB = table.rows.find((r) => r.sampleId === "B");
    expect(rowB?.gates[viableCol!.key]?.count).toBe(1);
    expect(rowB?.gates[earlyCol!.key]?.count).toBe(2);
  });

  it("requires selected parent gates when propagating child gates", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-propagate-parent-"));
    const sampleAPath = path.join(dir, "sampleA.fcs");
    const sampleBPath = path.join(dir, "sampleB.fcs");
    for (const fcsPath of [sampleAPath, sampleBPath]) {
      await writeTinyIntegerFcs({ fcsPath, channels: ["FSC-A", "SSC-A"], rows: [[10, 10], [50, 50]] });
    }
    const { workspacePath, workspace } = await initWorkspace({ rootDir: dir, samplePath: sampleAPath, sampleId: "A" });
    await writeWorkspace({
      workspacePath,
      workspace: { ...workspace, samples: [...workspace.samples, { id: "B", path: path.relative(path.dirname(workspacePath), sampleBPath) }] },
      expectedRevision: workspace.revision,
    });
    const ws = await readWorkspace(workspacePath);
    await upsertGates({
      workspacePath,
      expectedRevision: ws.revision,
      gates: [
        { id: "parent", name: "Parent", sample: "A", parent: "root", type: "rect", x: "FSC-A", y: "SSC-A", xMin: 0, xMax: 100, yMin: 0, yMax: 100 },
        { id: "child", name: "Child", sample: "A", parent: "parent", type: "rect", x: "FSC-A", y: "SSC-A", xMin: 10, xMax: 90, yMin: 10, yMax: 90 },
      ],
    });
    const current = await readWorkspace(workspacePath);
    const result = await propagateGates({
      workspacePath,
      sourceGateIds: ["child"],
      targetSampleIds: ["B"],
      expectedRevision: current.revision,
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("missing_source_parent_gate");
  });

  it("rejects propagation when a target sample is the source sample", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-propagate-self-"));
    const sampleAPath = path.join(dir, "sampleA.fcs");
    const sampleBPath = path.join(dir, "sampleB.fcs");
    for (const fcsPath of [sampleAPath, sampleBPath]) {
      await writeTinyIntegerFcs({ fcsPath, channels: ["FSC-A"], rows: [[50], [100]] });
    }
    const { workspacePath, workspace } = await initWorkspace({ rootDir: dir, samplePath: sampleAPath, sampleId: "A" });
    await writeWorkspace({
      workspacePath,
      workspace: { ...workspace, samples: [...workspace.samples, { id: "B", path: path.relative(path.dirname(workspacePath), sampleBPath) }] },
      expectedRevision: workspace.revision,
    });
    const ws = await readWorkspace(workspacePath);
    await upsertGates({
      workspacePath,
      expectedRevision: ws.revision,
      gates: [{ id: "gate_a", name: "Gate A", sample: "A", parent: "root", type: "range", x: "FSC-A", min: 30, max: 200 }],
    });
    const current = await readWorkspace(workspacePath);
    // Including the source sample (A) in targetSampleIds is an error
    const result = await propagateGates({
      workspacePath,
      sourceGateIds: ["gate_a"],
      targetSampleIds: ["A", "B"],
      expectedRevision: current.revision,
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("source_sample_target");
  });

  it("rejects propagation for unknown gate ids", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-propagate-unknown-gate-"));
    const sampleAPath = path.join(dir, "sampleA.fcs");
    const sampleBPath = path.join(dir, "sampleB.fcs");
    for (const fcsPath of [sampleAPath, sampleBPath]) {
      await writeTinyIntegerFcs({ fcsPath, channels: ["FSC-A"], rows: [[50], [100]] });
    }
    const { workspacePath, workspace } = await initWorkspace({ rootDir: dir, samplePath: sampleAPath, sampleId: "A" });
    await writeWorkspace({
      workspacePath,
      workspace: { ...workspace, samples: [...workspace.samples, { id: "B", path: path.relative(path.dirname(workspacePath), sampleBPath) }] },
      expectedRevision: workspace.revision,
    });
    const ws = await readWorkspace(workspacePath);
    const result = await propagateGates({
      workspacePath,
      sourceGateIds: ["nonexistent_gate"],
      targetSampleIds: ["B"],
      expectedRevision: ws.revision,
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("unknown_gate");
  });

  it("overwrites existing propagated gates on re-propagation", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-propagate-overwrite-"));
    const sampleAPath = path.join(dir, "sampleA.fcs");
    const sampleBPath = path.join(dir, "sampleB.fcs");
    for (const fcsPath of [sampleAPath, sampleBPath]) {
      await writeTinyIntegerFcs({ fcsPath, channels: ["FITC-A"], rows: [[5], [50], [200]] });
    }
    const { workspacePath, workspace } = await initWorkspace({ rootDir: dir, samplePath: sampleAPath, sampleId: "A" });
    await writeWorkspace({
      workspacePath,
      workspace: { ...workspace, samples: [...workspace.samples, { id: "B", path: path.relative(path.dirname(workspacePath), sampleBPath) }] },
      expectedRevision: workspace.revision,
    });
    const ws = await readWorkspace(workspacePath);
    await upsertGates({
      workspacePath,
      expectedRevision: ws.revision,
      gates: [{ id: "fitc_gate", name: "FITC+", sample: "A", parent: "root", type: "range", x: "FITC-A", min: 30, max: 250 }],
    });
    const v1 = await readWorkspace(workspacePath);
    // First propagation
    const r1 = await propagateGates({ workspacePath, sourceGateIds: ["fitc_gate"], targetSampleIds: ["B"], expectedRevision: v1.revision });
    expect(r1.ok).toBe(true);
    const afterFirst = await getPopulationTable({ workspacePath, sampleIds: ["B"], columnKey: "name_path" });
    expect(afterFirst.rows[0]!.gates["FITC+"]?.count).toBe(2);  // events ≥ 30: [50, 200]

    // Update source gate threshold on sample A, then re-propagate
    const v2 = await readWorkspace(workspacePath);
    await upsertGates({
      workspacePath,
      expectedRevision: v2.revision,
      gates: [{ id: "fitc_gate", name: "FITC+", sample: "A", parent: "root", type: "range", x: "FITC-A", min: 100, max: 250 }],
    });
    const v3 = await readWorkspace(workspacePath);
    const r2 = await propagateGates({ workspacePath, sourceGateIds: ["fitc_gate"], targetSampleIds: ["B"], expectedRevision: v3.revision });
    expect(r2.ok).toBe(true);
    // No duplicate gates — re-propagation overwrites, not appends
    const afterSecond = await readWorkspace(workspacePath);
    expect(afterSecond.gates.filter((g) => g.id === "fitc_gate__B")).toHaveLength(1);
    const afterSecondTable = await getPopulationTable({ workspacePath, sampleIds: ["B"], columnKey: "name_path" });
    // Updated threshold: only event [200] qualifies now
    expect(afterSecondTable.rows[0]!.gates["FITC+"]?.count).toBe(1);
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
    expect(packageJson.files).toContain("scripts/*.R");
    expect(packageJson.files).toContain("scripts/*.py");

    const sourceServer = await fs.readFile(path.resolve("src/mcp/server.ts"), "utf8");
    expect(sourceServer.startsWith("#!/usr/bin/env node\n")).toBe(true);
    const builtServer = await fs.readFile(path.resolve("dist/src/mcp/server.js"), "utf8");
    expect(builtServer.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("keeps FlowJo biex reference generation authoritative in R and Python supplementary", async () => {
    const rScript = await fs.readFile(path.resolve("scripts/generate-flowjo-biex-reference.R"), "utf8");
    const pythonScript = await fs.readFile(path.resolve("scripts/generate-flowjo-biex-reference.py"), "utf8");
    const gitignore = await fs.readFile(path.resolve(".gitignore"), "utf8");

    expect(rScript).toContain("flowWorkspace::flowjo_biexp");
    expect(rScript).toContain("testdata/fixtures/biex-transform-reference.json");
    expect(rScript).toContain("MIT-licensing note");
    expect(pythonScript).toContain("SUPPLEMENTARY CROSS-VALIDATOR");
    expect(pythonScript).toContain("not the primary fixture generator");
    expect(pythonScript).toContain("FlowKit's LogicleTransform");
    expect(pythonScript).toContain("_width_to_w() conversion is an approximation");
    expect(pythonScript).toContain("biex-transform-reference-python.json");
    expect(gitignore).toContain("testdata/fixtures/biex-transform-reference-python.json");
  });

  it("commits a finite FlowJo biex reference fixture generated by flowWorkspace", async () => {
    const reference = JSON.parse(
      await fs.readFile(biexTransformReferencePath, "utf8"),
    ) as BiexTransformReference;

    expect(reference.generator).toBe("flowWorkspace::flowjo_biexp");
    expect(reference.flowWorkspaceVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(reference.cases.map((entry) => entry.label)).toEqual([
      "flowjo_defaults",
      "flowjo_defaults_neg1",
      "fixture_wsp_biex",
      "aurora_style",
      "narrow_width",
    ]);

    for (const entry of reference.cases) {
      expect(entry.inputs.length).toBeGreaterThan(20);
      expect(entry.display).toHaveLength(entry.inputs.length);
      expect(entry.roundTrip).toHaveLength(entry.inputs.length);
      expect(entry.positiveInputMask).toHaveLength(entry.inputs.length);
      expect(entry.forwardToleranceDisplay).toBe(1);
      expect(entry.positiveForwardToleranceDisplay).toBe(0.01);
      expect(entry.inverseToleranceData).toBeGreaterThanOrEqual(entry.roundTripMaxError);
      expect(Object.hasOwn(entry, "toleranceAbsolute")).toBe(false);
      for (const spline of [entry.forwardSpline, entry.inverseSpline]) {
        expect(spline.x).toHaveLength(spline.y.length);
        expect(spline.b).toHaveLength(spline.x.length);
        expect(spline.c).toHaveLength(spline.x.length);
        expect(spline.d).toHaveLength(spline.x.length);
      }

      for (const value of [
        entry.parameters.length,
        entry.parameters.maxRange,
        entry.parameters.pos,
        entry.parameters.neg,
        entry.parameters.width,
        ...entry.inputs,
        ...entry.display,
        ...entry.roundTrip,
        entry.forwardToleranceDisplay,
        entry.positiveForwardToleranceDisplay,
        entry.inverseToleranceData,
        ...entry.forwardSpline.x,
        ...entry.forwardSpline.y,
        ...entry.forwardSpline.b,
        ...entry.forwardSpline.c,
        ...entry.forwardSpline.d,
        ...entry.inverseSpline.x,
        ...entry.inverseSpline.y,
        ...entry.inverseSpline.b,
        ...entry.inverseSpline.c,
        ...entry.inverseSpline.d,
      ]) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  it("evaluates FlowJo biex forward and inverse transforms against the reference fixture", async () => {
    const reference = JSON.parse(
      await fs.readFile(biexTransformReferencePath, "utf8"),
    ) as BiexTransformReference;

    for (const entry of reference.cases) {
      const xform = buildBiexTransform(entry.parameters);
      for (let index = 0; index < entry.inputs.length; index += 1) {
        const got = xform.forward(entry.inputs[index]);
        expect(Math.abs(got - entry.display[index]), `${entry.label} forward[${index}]`).toBeLessThan(entry.forwardToleranceDisplay);
        if (entry.positiveInputMask[index]) {
          expect(Math.abs(got - entry.display[index]), `${entry.label} positive forward[${index}]`).toBeLessThan(entry.positiveForwardToleranceDisplay);
        }
      }
      for (let index = 0; index < entry.display.length; index += 1) {
        const got = xform.inverse(entry.display[index]);
        expect(Math.abs(got - entry.inputs[index]), `${entry.label} inverse[${index}]`).toBeLessThan(entry.inverseToleranceData);
      }
    }
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
      await expect.poll(() => readWorkspace(workspacePath).then((workspace) => workspace.revision)).toBe(2);
      expect((await readWorkspace(workspacePath)).views[0]?.scale).toEqual({ x: "arcsinh", y: "arcsinh" });
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
      await expect.poll(() => readWorkspace(workspacePath).then((workspace) => workspace.revision)).toBe(8);
      await expect.poll(() => page.locator("#status").textContent()).toContain("Saved view revision 8");
      const revisionAfterScaleChanges = (await readWorkspace(workspacePath)).revision;
      await page.locator("#xSelect").selectOption("HDR-T");
      await page.locator("#ySelect").selectOption("FSC-A");
      await expect.poll(() => page.locator("#plot").getAttribute("aria-label")).toContain("HDR-T");

      await page.locator("#rectMode").click();
      const box = await page.locator("#plot").boundingBox();
      if (!box) throw new Error("Plot canvas has no bounding box.");
      await page.mouse.click(box.x + 20, box.y + 20);
      await page.locator("#saveGate").click();
      await expect.poll(() => readWorkspace(workspacePath).then((workspace) => workspace.revision)).toBe(revisionAfterScaleChanges);
      await page.mouse.move(box.x + 220, box.y + 180);
      await page.mouse.down();
      await page.mouse.move(box.x + 420, box.y + 340);
      await page.mouse.up();
      await page.locator("#gateName").fill("Root Gate");
      await page.locator("#saveGate").click();
      await expect.poll(() => readWorkspace(workspacePath).then((workspace) => workspace.revision)).toBe(revisionAfterScaleChanges + 1);
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
      await expect.poll(() => page.locator("#status").textContent()).toContain(`Ready revision ${revisionAfterScaleChanges + 1}`);
      await page.locator("#rectMode").click();
      await page.mouse.move(box.x + 260, box.y + 220);
      await page.mouse.down();
      await page.mouse.move(box.x + 460, box.y + 360);
      await page.mouse.up();
      await page.locator("#gateName").fill("Child Gate");
      await page.locator("#saveGate").click();
      await expect.poll(() => readWorkspace(workspacePath).then((workspace) => workspace.revision)).toBe(revisionAfterScaleChanges + 2);
      await expect.poll(() => page.locator("#status").textContent()).toContain(`revision ${revisionAfterScaleChanges + 2}`);
      const childWorkspace = await readWorkspace(workspacePath);
      expect(childWorkspace.gates).toHaveLength(2);
      const childGate = childWorkspace.gates[1];
      expect(childGate?.parent).toBe(rootGate.id);
      if (!childGate || childGate.type === "range") throw new Error("Child gate should be a 2D gate.");
      const parentOptions = await page.locator("#parentSelect option").evaluateAll((options) =>
        options.map((option) => ({ value: (option as HTMLOptionElement).value, label: option.textContent || "" })),
      );
      expect(parentOptions.find((option) => option.value === rootGate.id)?.label).toBe("\u00a0\u00a0\u00a0Root Gate");
      expect(parentOptions.find((option) => option.value === childGate?.id)?.label).toContain("\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0Child Gate");
      await expect.poll(() => page.getByRole("button", { name: "Collapse Root Gate" }).count()).toBe(1);
      await expect.poll(() => page.getByRole("button", { name: /^Child Gate rect$/ }).count()).toBe(1);
      await page.getByRole("button", { name: "Collapse Root Gate" }).click();
      await expect.poll(() => page.getByRole("button", { name: /^Child Gate rect$/ }).count()).toBe(0);
      const collapsedParentValues = await page.locator("#parentSelect option").evaluateAll((options) =>
        options.map((option) => (option as HTMLOptionElement).value),
      );
      expect(collapsedParentValues).toContain(childGate.id);
      await page.getByRole("button", { name: "Expand Root Gate" }).click();
      await expect.poll(() => page.getByRole("button", { name: /^Child Gate rect$/ }).count()).toBe(1);
      await expect.poll(() => page.locator("#populationStats").textContent()).toContain("events");
      await expect.poll(() => page.locator("#gateTray").evaluate((element) => element.hasAttribute("hidden"))).toBe(false);

      await upsertGate({
        workspacePath,
        expectedRevision: revisionAfterScaleChanges + 2,
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
      await expect.poll(() => page.locator("#status").textContent()).toContain(`Workspace revision ${revisionAfterScaleChanges + 3}`);
      await page.locator("#parentSelect").selectOption("root");
      await expect.poll(() => page.locator("#xSelect").inputValue()).toBe("FSC-A");
      expect(await page.locator("#ySelect").inputValue()).toBe("SSC-A");
      await page.getByRole("button", { name: /^Root Gate rect$/ }).click();
      await expect.poll(() => page.locator("#parentSelect").inputValue()).toBe(rootGate.id);
      await expect.poll(() => page.locator("#xSelect").inputValue()).toBe(childGate.x);
      await expect.poll(() => page.locator("#ySelect").inputValue()).toBe(childGate.y);

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
        expectedRevision: revisionAfterScaleChanges + 3,
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
      await expect.poll(() => page.locator("#status").textContent()).toContain(`Workspace revision ${revisionAfterScaleChanges + 4}`);
      await expect.poll(() => page.locator("#gateList").textContent()).toContain("<img src=x onerror=alert(1)>Agent Gate");
      await expect.poll(() => page.locator("#gateList img").count()).toBe(0);
    } finally {
      await page.close();
      await browser.close();
      await server.close();
    }
  }, 15000);

  it("supports square gates, drag-translate, and coupled quadrant creation", async () => {
    const { workspacePath } = await makeWorkspace();
    const server = await startGateEditorServer({ workspacePath, port: 0, maxEvents: 128 });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 900, height: 680 } });
    try {
      await page.goto(server.url);
      await page.locator("#plot").waitFor();
      await expect.poll(() => page.locator("#status").textContent()).toContain("Ready revision 0");
      const box = await page.locator("#plot").boundingBox();
      if (!box) throw new Error("Plot canvas has no bounding box.");

      await page.locator("#rectMode").click();
      await page.keyboard.down("Shift");
      await page.mouse.move(box.x + 150, box.y + 150);
      await page.mouse.down();
      await page.mouse.move(box.x + 350, box.y + 350);
      await page.mouse.up();
      await page.keyboard.up("Shift");
      await page.locator("#gateName").fill("Square Gate");
      await page.locator("#saveGate").click();
      await expect.poll(() => readWorkspace(workspacePath).then((workspace) => workspace.revision)).toBe(1);
      const squareWorkspace = await readWorkspace(workspacePath);
      const squareGate = squareWorkspace.gates.find((gate) => gate.name === "Square Gate");
      if (squareGate?.type !== "rect") throw new Error("Expected Square Gate rect.");
      expect(Math.abs((squareGate.xMax - squareGate.xMin) - (squareGate.yMax - squareGate.yMin))).toBeLessThan(1e-6);

      await upsertGate({
        workspacePath,
        expectedRevision: 1,
        gate: {
          id: "translate_gate",
          name: "Translate Gate",
          sample: "sample_001",
          parent: "root",
          type: "rect",
          x: squareGate.x,
          y: squareGate.y,
          xMin: squareGate.xMin - 100,
          xMax: squareGate.xMax + 100,
          yMin: squareGate.yMin - 100,
          yMax: squareGate.yMax + 100,
        },
      });
      await expect.poll(() => readWorkspace(workspacePath).then((workspace) => workspace.revision)).toBe(2);
      await expect.poll(() => page.locator("#status").textContent()).toContain("Workspace revision 2");
      const translateWorkspace = await readWorkspace(workspacePath);
      const translateGate = translateWorkspace.gates.find((gate) => gate.name === "Translate Gate");
      if (translateGate?.type !== "rect") throw new Error("Expected Translate Gate rect.");
      const translatePreview = await getEventPreview({
        workspacePath,
        sampleId: "sample_001",
        parent: "root",
        x: translateGate.x,
        y: translateGate.y,
        maxEvents: 128,
      });
      const translateBounds = {
        xMin: Number.POSITIVE_INFINITY,
        xMax: Number.NEGATIVE_INFINITY,
        yMin: Number.POSITIVE_INFINITY,
        yMax: Number.NEGATIVE_INFINITY,
      };
      translatePreview.points?.forEach((point) => {
        translateBounds.xMin = Math.min(translateBounds.xMin, point[0]);
        translateBounds.xMax = Math.max(translateBounds.xMax, point[0]);
        translateBounds.yMin = Math.min(translateBounds.yMin, point[1]);
        translateBounds.yMax = Math.max(translateBounds.yMax, point[1]);
      });
      [squareGate, translateGate].forEach((gate) => {
        translateBounds.xMin = Math.min(translateBounds.xMin, gate.xMin, gate.xMax);
        translateBounds.xMax = Math.max(translateBounds.xMax, gate.xMin, gate.xMax);
        translateBounds.yMin = Math.min(translateBounds.yMin, gate.yMin, gate.yMax);
        translateBounds.yMax = Math.max(translateBounds.yMax, gate.yMin, gate.yMax);
      });
      const xPad = (translateBounds.xMax - translateBounds.xMin) * 0.06;
      const yPad = (translateBounds.yMax - translateBounds.yMin) * 0.06;
      translateBounds.xMin -= xPad;
      translateBounds.xMax += xPad;
      translateBounds.yMin -= yPad;
      translateBounds.yMax += yPad;
      const plotArea = {
        left: 58,
        top: 18,
        width: box.width - 58 - 16,
        height: box.height - 18 - 44,
      };
      const gateCenter = [
        (translateGate.xMin + translateGate.xMax) / 2,
        (translateGate.yMin + translateGate.yMax) / 2,
      ];
      const gateCenterScreen = [
        box.x + plotArea.left + ((gateCenter[0] - translateBounds.xMin) / (translateBounds.xMax - translateBounds.xMin)) * plotArea.width,
        box.y + plotArea.top + plotArea.height - ((gateCenter[1] - translateBounds.yMin) / (translateBounds.yMax - translateBounds.yMin)) * plotArea.height,
      ];

      await page.locator("#selectMode").click();
      await page.mouse.move(gateCenterScreen[0], gateCenterScreen[1]);
      await page.mouse.down();
      await page.mouse.move(gateCenterScreen[0] + 40, gateCenterScreen[1] + 35);
      await page.mouse.up();
      await page.locator("#saveGate").click();
      await expect.poll(() => readWorkspace(workspacePath).then((workspace) => workspace.revision)).toBe(3);
      await expect.poll(() => page.locator("#status").textContent()).toContain("revision 3");
      const translatedWorkspace = await readWorkspace(workspacePath);
      const translatedGate = translatedWorkspace.gates.find((gate) => gate.id === translateGate.id);
      if (translatedGate?.type !== "rect") throw new Error("Expected translated rect.");
      expect(translatedGate.xMin).not.toBe(translateGate.xMin);
      expect(translatedGate.xMax).not.toBe(translateGate.xMax);
      expect(translatedGate.yMin).not.toBe(translateGate.yMin);
      expect(translatedGate.yMax).not.toBe(translateGate.yMax);

      await page.locator("#quadrantMode").click();
      await page.locator("#gateName").fill("Apoptosis");
      await page.mouse.click(box.x + 320, box.y + 260);
      expect((await readWorkspace(workspacePath)).revision).toBe(3);
      await page.locator("#saveGate").click();
      await expect.poll(() => readWorkspace(workspacePath).then((workspace) => workspace.revision)).toBe(4);
      const quadrantWorkspace = await readWorkspace(workspacePath);
      const quadrant = quadrantWorkspace.gates.find((gate) => gate.name === "Apoptosis");
      expect(quadrant?.type).toBe("quadrant");
      if (quadrant?.type !== "quadrant") throw new Error("Expected coupled quadrant gate.");
      expect(quadrant.parent).toBe("root");
      expect(quadrant.quadrants.map((population) => population.name).sort()).toEqual(["Apoptosis Q1", "Apoptosis Q2", "Apoptosis Q3", "Apoptosis Q4"]);
      expect((await validateWorkspace(workspacePath)).ok).toBe(true);
    } finally {
      await page.close();
      await browser.close();
      await server.close();
    }
  }, 15000);

  it("keeps the logical parent population and fixed axes when switching samples", async () => {
    const { workspacePath } = await makeWorkspace();
    const workspace = await readWorkspace(workspacePath);
    const samplePath = workspace.samples[0]?.path;
    if (!samplePath) throw new Error("Expected fixture sample path.");
    const written = await writeWorkspace({
      workspacePath,
      expectedRevision: workspace.revision,
      workspace: {
        ...workspace,
        samples: [...workspace.samples, { id: "sample_002", path: samplePath }],
        gates: [
          {
            id: "main_a",
            name: "Main cells",
            sample: "sample_001",
            parent: "root",
            type: "rect",
            x: "FSC-A",
            y: "SSC-A",
            xMin: 0,
            xMax: 200,
            yMin: 0,
            yMax: 200,
          },
          {
            id: "singlets_a",
            name: "Singlets",
            sample: "sample_001",
            parent: "main_a",
            type: "rect",
            x: "HDR-T",
            y: "FSC-A",
            xMin: 0,
            xMax: 200,
            yMin: 0,
            yMax: 200,
          },
          {
            id: "main_b",
            name: "Main cells",
            sample: "sample_002",
            parent: "root",
            type: "rect",
            x: "FSC-A",
            y: "SSC-A",
            xMin: 0,
            xMax: 200,
            yMin: 0,
            yMax: 200,
          },
          {
            id: "singlets_b",
            name: "Singlets",
            sample: "sample_002",
            parent: "main_b",
            type: "rect",
            x: "HDR-T",
            y: "FSC-A",
            xMin: 0,
            xMax: 200,
            yMin: 0,
            yMax: 200,
          },
        ],
      },
    });
    expect(written.ok).toBe(true);
    const server = await startGateEditorServer({
      workspacePath,
      port: 0,
      maxEvents: 128,
      sampleId: "sample_001",
      parent: "main_a",
      x: "HDR-T",
      y: "FSC-A",
    });
    const initialState = await fetch(`${server.url}api/state`).then((response) => response.json()) as { parent?: string; x?: string; y?: string };
    expect(initialState).toMatchObject({ parent: "main_a", x: "HDR-T", y: "FSC-A" });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 900, height: 680 } });
    try {
      await page.goto(server.url);
      await expect.poll(() => page.locator("#parentSelect").inputValue()).toBe("main_a");
      await expect.poll(() => page.locator("#xSelect").inputValue()).toBe("HDR-T");
      expect(await page.locator("#ySelect").inputValue()).toBe("FSC-A");

      await page.locator("#sampleSelect").selectOption("sample_002");

      await expect.poll(() => page.locator("#parentSelect").inputValue()).toBe("main_b");
      expect(await page.locator("#xSelect").inputValue()).toBe("HDR-T");
      expect(await page.locator("#ySelect").inputValue()).toBe("FSC-A");

      const beforeViewSave = (await readWorkspace(workspacePath)).revision;
      await page.locator("#xScale").selectOption("biex");
      await expect.poll(() => readWorkspace(workspacePath).then((value) => value.revision)).toBe(beforeViewSave + 1);
      const savedView = (await readWorkspace(workspacePath)).views.find((view) => view.sample === "sample_002");
      expect(savedView).toMatchObject({
        parent: "main_b",
        x: "HDR-T",
        y: "FSC-A",
        scale: { x: "biex", y: "linear" },
      });
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
      expect(tools.tools.some((tool) => tool.name === "suggest_singlet_gate")).toBe(true);
      expect(tools.tools.some((tool) => tool.name === "suggest_apoptosis_quadrants")).toBe(true);
      expect(tools.tools.some((tool) => tool.name === "get_population_graph")).toBe(true);
      expect(tools.tools.some((tool) => tool.name === "upsert_gates")).toBe(true);
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

      const unstainedPath = path.join(dir, "unstained.fcs");
      const fitcPath = path.join(dir, "fitc_control.fcs");
      const pePath = path.join(dir, "pe_control.fcs");
      await writeTinyIntegerFcs({
        fcsPath: unstainedPath,
        channels: ["FITC-A", "PE-A"],
        rows: [[10, 20], [10, 20], [10, 20]],
      });
      await writeTinyIntegerFcs({
        fcsPath: fitcPath,
        channels: ["FITC-A", "PE-A"],
        rows: [[110, 40], [110, 40], [110, 40]],
      });
      await writeTinyIntegerFcs({
        fcsPath: pePath,
        channels: ["FITC-A", "PE-A"],
        rows: [[15, 220], [15, 220], [15, 220]],
      });
      const estimated = await client.callTool({
        name: "estimate_compensation_from_controls",
        arguments: {
          id: "controls_fitc_pe",
          sample: "comp_sample",
          channels: ["FITC-A", "PE-A"],
          unstained_path: unstainedPath,
          controls: [
            { path: fitcPath, channel: "FITC-A" },
            { path: pePath, channel: "PE-A" },
          ],
        },
      });
      const estimatedResult = (estimated.structuredContent as { result?: unknown } | undefined)?.result as {
        ok: boolean;
        compensation: CompensationMatrix;
        diagnostics: { method: string };
      };
      expect(estimatedResult.ok).toBe(true);
      expect(estimatedResult.compensation).toMatchObject({
        id: "controls_fitc_pe",
        source: "controls",
        // Same controls as the core-level test: FITC leaks 20% into PE.
        matrix: [[1, 0.2], [0.025, 1]],
      });
      expect(estimatedResult.diagnostics.method).toBe("median_ratio");

      const upserted = await client.callTool({
        name: "upsert_compensation_matrix",
        arguments: {
          workspace_path: openedResult.workspacePath,
          expected_revision: 1,
          compensation: estimatedResult.compensation,
        },
      });
      const upsertedResult = (upserted.structuredContent as { result?: unknown } | undefined)?.result as {
        ok: boolean;
        revision: number;
        compensation: CompensationMatrix;
      };
      expect(upsertedResult.ok).toBe(true);
      expect(upsertedResult.revision).toBe(2);
      expect(upsertedResult.compensation.source).toBe("controls");
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
        "estimate_compensation_from_controls",
        "export_flowjo_workspace",
        "get_compensation_matrix",
        "get_event_preview",
        "get_gate_editor_state",
        "get_plot_context",
        "get_population_graph",
        "get_population_table",
        "get_sample_metadata",
        "get_workspace_revision",
        "import_flowjo_workspace",
        "list_compensations",
        "list_samples",
        "open_fcs",
        "open_gate_editor",
        "open_workspace",
        "probe_inline_image",
        "propagate_gates",
        "read_workspace",
        "render_gate_editor",
        "render_plot",
        "render_plot_image",
        "suggest_apoptosis_quadrants",
        "suggest_singlet_gate",
        "upsert_compensation_matrix",
        "upsert_gate",
        "upsert_gates",
        "upsert_view",
        "validate_workspace",
        "write_workspace",
      ]);
      const openTool = tools.tools.find((tool) => tool.name === "open_gate_editor") as {
        _meta?: Record<string, unknown>;
        description?: string;
        inputSchema?: unknown;
      } | undefined;
      const openSchema = JSON.stringify(openTool?.inputSchema ?? {});
      expect(openTool?._meta?.["openai/outputTemplate"]).toBe("ui://flowcyto/gate-editor-v1.html");
      expect((openTool?._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri).toBe("ui://flowcyto/gate-editor-v1.html");
      expect(openTool?.description).toContain("reuse_session=false");
      expect(openSchema).toContain("session_id");
      expect(openSchema).toContain("reuse_session");
      for (const name of ["get_plot_context", "get_workspace_revision", "upsert_gate", "upsert_gates", "delete_gate"]) {
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
      expect(resourceHtml).toContain("/api/gates/upsert-many");
      expect(resourceHtml).toContain("value !== undefined");
      expect(resourceHtml).toContain("<canvas id=\"plot\"");

      const flowJoDir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-mcp-flowjo-import-"));
      const flowJoSamplePath = path.join(flowJoDir, "sample.fcs");
      await writeTinyIntegerFcs({
        fcsPath: flowJoSamplePath,
        channels: ["FSC-A", "SSC-A"],
        rows: [[100, 200], [150, 250]],
      });
      const imported = await client.callTool({
        name: "import_flowjo_workspace",
        arguments: {
          wsp_path: path.join(flowJoFixtureDir, "minimal-linear-rect.wsp"),
          workspace_dir: flowJoDir,
          sample_path_map: { "sample.fcs": flowJoSamplePath },
        },
      });
      const importedResult = (imported.structuredContent as { result?: unknown } | undefined)?.result as {
        ok: boolean;
        workspacePath: string;
        samplesImported: number;
        gatesImported: number;
      };
      expect(importedResult).toMatchObject({ ok: true, samplesImported: 1, gatesImported: 1 });
      expect((await readWorkspace(importedResult.workspacePath)).gates[0]).toMatchObject({
        id: "gate-rect-001",
        type: "rect",
        x: "FSC-A",
        y: "SSC-A",
      });

      const exportedPath = path.join(flowJoDir, "mcp-export.wsp");
      const exported = await client.callTool({
        name: "export_flowjo_workspace",
        arguments: {
          workspace_path: importedResult.workspacePath,
          output_path: exportedPath,
        },
      });
      const exportedResult = (exported.structuredContent as { result?: unknown } | undefined)?.result as {
        ok: boolean;
        wspPath: string;
        gatesExported: number;
      };
      expect(exportedResult).toMatchObject({ ok: true, wspPath: exportedPath, gatesExported: 1 });

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
