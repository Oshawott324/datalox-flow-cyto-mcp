import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readWorkspace, validateWorkspaceObject, type FlowcytoWorkspace, type WorkspaceGate } from "../src/core/index.js";
import { fileSha256, journalPathFor, readJournal } from "../src/app/workstation/journal.js";
import { applyOperation } from "../src/app/workstation/operations.js";
import { startWorkstation, type WorkstationServer } from "../src/app/workstation/server.js";

const CHANNELS = ["FSC-A", "SSC-A", "FL1-A", "FL2-A"];
const SAMPLES = ["tube_a", "tube_b", "tube_c"];

/** Deterministic events: a cell cloud and a debris cloud, half the cells FL1-bright. */
function events(seed: number, count: number): number[][] {
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());
  const clamp = (value: number) => Math.max(0, Math.min(65535, Math.round(value)));
  return Array.from({ length: count }, (_, index) => {
    const debris = index % 5 === 0;
    const bright = index % 2 === 0;
    return [
      clamp((debris ? 4000 : 30000) + gauss() * 2500),
      clamp((debris ? 3000 : 20000) + gauss() * 2000),
      clamp((bright ? 20000 : 600) + gauss() * 400),
      clamp(800 + (bright ? 0.1 * 20000 : 0) + gauss() * 300),
    ];
  });
}

async function writeFcs(file: string, rows: number[][]): Promise<void> {
  const data = Buffer.alloc(rows.length * CHANNELS.length * 2);
  rows.flat().forEach((value, index) => data.writeUInt16LE(value, index * 2));
  const text = (begin: number, end: number) => {
    const entries = [
      "$BEGINANALYSIS", "0", "$BEGINDATA", String(begin).padStart(12, "0"), "$BYTEORD", "1,2,3,4", "$DATATYPE", "I",
      "$ENDANALYSIS", "0", "$ENDDATA", String(end).padStart(12, "0"), "$MODE", "L", "$NEXTDATA", "0",
      "$PAR", String(CHANNELS.length), "$TOT", String(rows.length),
    ];
    CHANNELS.forEach((channel, index) => entries.push(`$P${index + 1}B`, "16", `$P${index + 1}N`, channel, `$P${index + 1}R`, "65536"));
    return `|${entries.join("|")}|`;
  };
  const start = 58;
  const dataStart = start + text(0, 0).length;
  const body = text(dataStart, dataStart + data.length - 1);
  const header = `FCS3.1    ${String(start).padStart(8)}${String(start + body.length - 1).padStart(8)}${String(dataStart).padStart(8)}${String(dataStart + data.length - 1).padStart(8)}${"0".padStart(8)}${"0".padStart(8)}`;
  await fs.writeFile(file, Buffer.concat([Buffer.from(header, "ascii"), Buffer.from(body, "latin1"), data]));
}

async function makeRun(): Promise<{ dir: string; workspacePath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-workstation-"));
  await fs.mkdir(path.join(dir, "fcs"));
  for (const [index, id] of SAMPLES.entries()) await writeFcs(path.join(dir, "fcs", `${id}.fcs`), events(index + 7, 3000));
  const workspace: FlowcytoWorkspace = {
    version: 1,
    revision: 5,
    samples: SAMPLES.map((id) => ({ id, path: path.join(dir, "fcs", `${id}.fcs`) })),
    views: [],
    gates: [],
    compensations: [{ id: "acquisition", source: "fcs_keyword", sample: "tube_a", keyword: "$SPILLOVER", channels: ["FL1-A", "FL2-A"], matrix: [[1, 0.1], [0, 1]] }],
  };
  const workspacePath = path.join(dir, "flowcyto.workspace.json");
  await fs.writeFile(workspacePath, `${JSON.stringify(workspace, null, 2)}\n`);
  return { dir, workspacePath };
}

const cells = (sample: string, id = `${sample}_cells`): WorkspaceGate => ({
  id, name: "Cells", sample, parent: "root", type: "rect", x: "FSC-A", y: "SSC-A", xMin: 15000, xMax: 1e12, yMin: 10000, yMax: 1e12,
});
const bright = (sample: string, parent: string, id = `${sample}_bright`): WorkspaceGate => ({
  id, name: "FL1+", sample, parent, type: "range", x: "FL1-A", min: 8000, max: 1e12,
});

describe("workstation operations", () => {
  const base = (): FlowcytoWorkspace => ({
    version: 1,
    revision: 1,
    samples: SAMPLES.map((id) => ({ id, path: `${id}.fcs` })),
    views: [],
    gates: [
      cells("tube_a"),
      bright("tube_a", "tube_a_cells"),
      {
        id: "quad", sample: "tube_a", parent: "tube_a_cells", type: "quadrant", x: "FL1-A", y: "FL2-A", xThreshold: 5000, yThreshold: 2000,
        quadrants: [
          { id: "q1", name: "Q1", x: "-", y: "+" }, { id: "q2", name: "Q2", x: "+", y: "+" },
          { id: "q3", name: "Q3", x: "+", y: "-" }, { id: "q4", name: "Q4", x: "-", y: "-" },
        ],
      },
      { ...bright("tube_a", "q2", "below_q2"), name: "Below Q2" },
      cells("tube_b", "b_cells_existing"),
    ],
    compensations: [{ id: "acq", source: "fcs_keyword", sample: "tube_a", channels: ["FL1-A"], matrix: [[1]] }],
  });

  it("deletes a gate with every gate below it, including below quadrant populations", () => {
    const { workspace, detail } = applyOperation(base(), { op: "gate.delete", gateId: "tube_a_cells" });
    expect(workspace.gates.map((gate) => gate.id)).toEqual(["b_cells_existing"]);
    expect((detail.removed as WorkspaceGate[]).map((gate) => gate.id).sort()).toEqual(["below_q2", "quad", "tube_a_bright", "tube_a_cells"]);
  });

  it("copies a population to other samples, reusing same-named ancestors and replacing same-named gates", () => {
    const start = base();
    const first = applyOperation(start, { op: "population.copy", sampleId: "tube_a", populationId: "tube_a_bright", targetSamples: ["tube_a", "tube_b", "tube_c"] });
    const gates = first.workspace.gates;
    expect(first.detail).toMatchObject({ targets: ["tube_b", "tube_c"], created: 3, replaced: 0 });
    const bBright = gates.find((gate) => gate.sample === "tube_b" && gate.name === "FL1+")!;
    expect(bBright.parent).toBe("b_cells_existing");
    const cCells = gates.find((gate) => gate.sample === "tube_c" && gate.name === "Cells")!;
    expect(gates.find((gate) => gate.sample === "tube_c" && gate.name === "FL1+")!.parent).toBe(cCells.id);

    const moved = { ...(gates.find((gate) => gate.id === "tube_a_bright") as Extract<WorkspaceGate, { type: "range" }>), min: 9000 };
    const edited = applyOperation(first.workspace, { op: "gate.save", gate: moved });
    const second = applyOperation(edited.workspace, { op: "population.copy", sampleId: "tube_a", populationId: "tube_a_bright", targetSamples: ["tube_b"] });
    expect(second.detail).toMatchObject({ created: 0, replaced: 1 });
    const replaced = second.workspace.gates.find((gate) => gate.id === bBright.id) as Extract<WorkspaceGate, { type: "range" }>;
    expect(replaced.min).toBe(9000);
  });

  it("copies a quadrant population's gate with its quadrants and the gates below them", () => {
    const { workspace } = applyOperation(base(), { op: "population.copy", sampleId: "tube_a", populationId: "q2", targetSamples: ["tube_c"] });
    const quad = workspace.gates.find((gate) => gate.sample === "tube_c" && gate.type === "quadrant") as Extract<WorkspaceGate, { type: "quadrant" }>;
    expect(quad.quadrants.map((population) => population.name)).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    const below = workspace.gates.find((gate) => gate.sample === "tube_c" && gate.name === "Below Q2")!;
    expect(below.parent).toBe(quad.quadrants[1]!.id);
  });

  it("renames quadrant populations and gates", () => {
    const quadrant = applyOperation(base(), { op: "population.rename", populationId: "q3", name: "CD4+ Tet-" }).workspace;
    expect((quadrant.gates.find((gate) => gate.id === "quad") as Extract<WorkspaceGate, { type: "quadrant" }>).quadrants[2]!.name).toBe("CD4+ Tet-");
    const gate = applyOperation(base(), { op: "population.rename", populationId: "tube_a_bright", name: "Bright" }).workspace;
    expect(gate.gates.find((entry) => entry.id === "tube_a_bright")!.name).toBe("Bright");
  });

  it("keeps acquisition matrices read-only and clears their use when a matrix is deleted", () => {
    expect(() => applyOperation(base(), { op: "compensation.save", compensation: { id: "acq", source: "manual", channels: ["FL1-A"], matrix: [[1]] } }))
      .toThrow(/cannot be changed/);
    const saved = applyOperation(base(), { op: "compensation.save", compensation: { id: "run_controls", source: "manual", channels: ["FL1-A", "FL2-A"], matrix: [[1, 0.1], [0.02, 1]] } }).workspace;
    const applied = applyOperation(saved, { op: "compensation.apply", compensationId: "run_controls", samples: ["tube_a", "tube_b"] }).workspace;
    expect(applied.sampleCompensation).toEqual({ tube_a: "run_controls", tube_b: "run_controls" });
    const deleted = applyOperation(applied, { op: "compensation.delete", compensationId: "run_controls" }).workspace;
    expect(deleted.sampleCompensation).toEqual({});
    expect(() => applyOperation(base(), { op: "compensation.save", compensation: { id: "bad", source: "manual", channels: ["FL1-A", "FL2-A"], matrix: [[1, 0]] } }))
      .toThrow(/square/);
  });

  it("validates groups, per-sample compensation and axis settings", async () => {
    const workspace = {
      ...base(),
      groups: [{ id: "g", name: "Stained", samples: ["tube_a", "nope"] }],
      sampleCompensation: { tube_b: "acq" },
      axes: { "FL1-A": { scale: "biex", min: 10, max: 5, width: -1 } },
    };
    const result = await validateWorkspaceObject("/tmp/none.json", workspace);
    const codes = result.errors.map((error) => error.code);
    expect(codes).toEqual(expect.arrayContaining(["unknown_sample", "compensation_sample_mismatch", "invalid_axis_range", "invalid_axis_width"]));
  });
});

describe("workstation service", () => {
  let run: { dir: string; workspacePath: string };
  let server: WorkstationServer;
  const post = async (operation: unknown, expectedRevision: number, via?: string) => {
    const response = await fetch(`${server.url}api/op`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation, expectedRevision, via }),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };

  beforeAll(async () => {
    run = await makeRun();
    server = await startWorkstation({ workspacePath: run.workspacePath });
  });
  afterAll(async () => {
    await server?.close();
  });

  it("serves the page, the workspace and default axes", async () => {
    const page = await fetch(server.url).then((response) => response.text());
    expect(page).toContain("Flowcyto Workstation");
    const state = await fetch(`${server.url}api/state`).then((response) => response.json()) as Record<string, any>;
    expect(state.revision).toBe(5);
    expect(state.samples.map((sample: { name: string }) => sample.name)).toEqual(["tube_a.fcs", "tube_b.fcs", "tube_c.fcs"]);
    expect(state.axisDefaults["FSC-A"]).toMatchObject({ scale: "linear", min: 0, max: 65536 });
    expect(state.axisDefaults["FL1-A"].scale).toBe("biex");
  });

  it("writes each change as one revision and journals it", async () => {
    const first = await post({ op: "gate.save", gate: cells("tube_a") }, 5, "draw:rect");
    expect(first).toMatchObject({ status: 200, body: { ok: true, revision: 6 } });
    const stale = await post({ op: "gate.save", gate: bright("tube_a", "tube_a_cells") }, 5);
    expect(stale.status).toBe(409);
    const invalid = await post({ op: "gate.save", gate: { ...bright("tube_a", "missing_parent") } }, 6);
    expect(invalid.status).toBe(422);
    const second = await post({ op: "gate.save", gate: bright("tube_a", "tube_a_cells") }, 6, "manual");
    expect(second.body.revision).toBe(7);

    const journal = await readJournal(run.workspacePath);
    expect(journal.map((entry) => [entry.action, entry.revision])).toEqual([["open", 5], ["gate.save", 6], ["gate.save", 7]]);
    expect(journal[1]!.detail).toMatchObject({ via: "draw:rect", gate: { id: "tube_a_cells" } });
    expect(journal.at(-1)!.sha256).toBe(await fileSha256(run.workspacePath));
    expect(journalPathFor(run.workspacePath)).toBe(path.join(run.dir, "flowcyto.workspace.journal.jsonl"));
  });

  it("returns population events and counts that agree", async () => {
    const tree = await fetch(`${server.url}api/tree`).then((response) => response.json()) as Record<string, any>;
    const counts = tree.samples.tube_a.populations;
    expect(counts.tube_a_cells.parentCount).toBe(3000);
    expect(counts.tube_a_bright.parentCount).toBe(counts.tube_a_cells.count);
    const params = new URLSearchParams({ sample: "tube_a", population: "tube_a_bright", channels: "FL1-A" });
    const events = await fetch(`${server.url}api/events?${params}`).then((response) => response.json()) as Record<string, any>;
    expect(events.count).toBe(counts.tube_a_bright.count);
    const values = new Float64Array(Buffer.from(events.columns[0], "base64").buffer.slice(0));
    expect(Math.min(...values)).toBeGreaterThanOrEqual(8000);
  });

  it("records an outside write as a mismatch when the workspace is opened again", async () => {
    const workspace = await readWorkspace(run.workspacePath);
    await fs.writeFile(run.workspacePath, `${JSON.stringify({ ...workspace, revision: workspace.revision + 1 }, null, 2)}\n`);
    const reopened = await startWorkstation({ workspacePath: run.workspacePath });
    await reopened.close();
    expect((await readJournal(run.workspacePath)).at(-1)).toMatchObject({ action: "open", matchesJournal: false });
  });
});

const chromiumInstalled = await (async () => {
  try {
    const { chromium } = await import("playwright");
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

describe.skipIf(!chromiumInstalled)("workstation in a browser", () => {
  let run: { dir: string; workspacePath: string };
  let server: WorkstationServer;
  let browser: import("playwright").Browser;
  let page: import("playwright").Page;

  beforeAll(async () => {
    run = await makeRun();
    server = await startWorkstation({ workspacePath: run.workspacePath });
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(server.url);
    await page.getByRole("treeitem", { name: "Sample tube_a.fcs" }).waitFor();
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("draws, names, copies and compensates through the interface alone", async () => {
    await page.getByRole("treeitem", { name: "Sample tube_a.fcs" }).dblclick();
    const graph = page.getByRole("dialog", { name: /tube_a\.fcs/ });
    await graph.getByRole("button", { name: "Rectangle gate" }).click();
    const canvas = graph.locator("canvas");
    await canvas.waitFor();
    await page.waitForTimeout(500);
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + 220, box.y + 330);
    await page.mouse.down();
    await page.mouse.move(box.x + 400, box.y + 160, { steps: 8 });
    await page.mouse.up();
    await page.getByRole("textbox", { name: "Subset name" }).fill("Cells");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await readWorkspace(run.workspacePath)).gates.length).toBe(1);

    // a child gate typed into Manual Gate Definition (Ctrl+G) on a histogram
    await page.getByRole("button", { name: /^Close tube_a\.fcs — All events/ }).click();
    await page.getByRole("treeitem", { name: "Sample tube_a.fcs" }).click();
    await page.keyboard.press("ArrowRight");
    await page.getByRole("treeitem", { name: "Population Cells" }).dblclick();
    const child = page.getByRole("dialog", { name: /tube_a\.fcs — Cells/ });
    await child.getByRole("button", { name: /^Y axis:/ }).click();
    await page.getByRole("menuitemcheckbox", { name: "Histogram" }).click();
    await child.getByRole("button", { name: /^X axis:/ }).click();
    await page.getByRole("menuitemcheckbox", { name: "FL1-A" }).click();
    await child.locator("canvas").click({ position: { x: 4, y: 4 } });
    await page.keyboard.press("Control+g");
    await page.getByRole("textbox", { name: "X lower limit" }).fill("8000");
    await page.getByRole("textbox", { name: "X upper limit" }).fill("inf");
    await page.getByRole("button", { name: "OK" }).click();
    await page.getByRole("textbox", { name: "Subset name" }).fill("FL1+");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await readWorkspace(run.workspacePath)).gates.length).toBe(2);

    // copy the tree to every sample from the population's context menu
    await page.getByRole("button", { name: /^Close tube_a\.fcs — Cells/ }).click();
    await page.getByRole("treeitem", { name: "Population Cells" }).click();
    await page.keyboard.press("ArrowRight");
    await page.getByRole("treeitem", { name: "Population FL1+" }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Copy to Group" }).hover();
    await page.getByRole("menuitem", { name: "All Samples (3)" }).click();
    await expect.poll(async () => (await readWorkspace(run.workspacePath)).gates.length).toBe(6);

    // a matrix entered in the Matrix Editor and applied to all samples
    await page.getByRole("tab", { name: "Tools" }).click();
    await page.getByRole("button", { name: "Matrix Editor" }).click();
    await page.getByRole("button", { name: "+ New" }).click();
    await page.getByRole("textbox", { name: "Matrix name" }).fill("run_controls");
    await page.keyboard.press("Enter");
    const cell = page.getByRole("textbox", { name: "Spillover of FL1-A into FL2-A" });
    await cell.fill("10");
    await cell.press("Tab");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "Apply Matrix ▾" }).click();
    await page.getByRole("menuitem", { name: "All Samples (3)" }).click();

    await expect.poll(async () => (await readWorkspace(run.workspacePath)).sampleCompensation).toEqual({ tube_a: "run_controls", tube_b: "run_controls", tube_c: "run_controls" });
    const workspace = await readWorkspace(run.workspacePath);
    expect(workspace.compensations!.find((matrix) => matrix.id === "run_controls")!.matrix[0]).toEqual([1, 0.1]);
    const journal = await readJournal(run.workspacePath);
    expect(journal.filter((entry) => entry.action !== "open").map((entry) => entry.detail?.via)).toEqual([
      "draw:rect", "manual", "copy", "matrix-editor", "matrix-editor", "apply-matrix",
    ]);
    expect(journal.at(-1)!.revision).toBe(workspace.revision);
  }, 60_000);
});
