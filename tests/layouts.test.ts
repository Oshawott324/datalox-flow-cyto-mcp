import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  deleteLayout,
  getLayout,
  initWorkspace,
  listLayouts,
  readWorkspace,
  upsertLayout,
  validateLayout,
  writeWorkspace,
  type FlowcytoLayout,
  type LayoutPanel,
} from "../src/core/index.js";

// The third parameter is named by detector with a marker alias, mirroring the real
// tetramer workspace where $SPILLOVER uses FL03-A and the UI shows FITC-A.
const CHANNELS = ["FSC-A", "SSC-A", "FL03-A"];
const MARKERS: Array<string | undefined> = [undefined, undefined, "FITC-A"];

async function writeTinyFcs(fcsPath: string): Promise<void> {
  const rows = [[10, 20, 30], [40, 50, 60], [70, 80, 90]];
  const data = Buffer.alloc(rows.length * CHANNELS.length * 2);
  let cursor = 0;
  for (const row of rows) {
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
      "$PAR", String(CHANNELS.length),
      "$TOT", String(rows.length),
    ];
    CHANNELS.forEach((channel, index) => {
      const number = index + 1;
      entries.push(`$P${number}B`, "16", `$P${number}N`, channel, `$P${number}R`, "65535");
      const marker = MARKERS[index];
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

/** One workspace reused read-only by the validation tests; writers use their own copy. */
let sharedWorkspacePath = "";

async function makeLayoutWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowcyto-layouts-"));
  await fs.mkdir(path.join(dir, "data"));
  const fcsPath = path.join(dir, "data", "sample.fcs");
  await writeTinyFcs(fcsPath);
  const init = await initWorkspace({ rootDir: dir, samplePath: fcsPath, sampleId: "sample_a" });

  const workspace = await readWorkspace(init.workspacePath);
  const seeded = await writeWorkspace({
    workspacePath: init.workspacePath,
    expectedRevision: workspace.revision,
    workspace: {
      ...workspace,
      samples: [...workspace.samples, { id: "sample_b", path: "data/sample.fcs" }],
      gates: [
        {
          id: "lymph", name: "Lymphocytes", sample: "sample_a", parent: "root", type: "polygon",
          x: "FSC-A", y: "SSC-A", vertices: [[1, 1], [50, 1], [50, 50]],
        },
        {
          id: "live", name: "Live", sample: "sample_a", parent: "lymph", type: "rect",
          x: "FSC-A", y: "SSC-A", xMin: 2, xMax: 40, yMin: 2, yMax: 40,
        },
      ],
      compensations: [
        { id: "comp_1", source: "manual", channels: ["FITC-A"], matrix: [[1]] },
      ],
    },
  });
  expect(seeded.ok).toBe(true);
  return init.workspacePath;
}

const position = { x: 0, y: 0, width: 256, height: 256 };

function panel(overrides: Partial<LayoutPanel> = {}): LayoutPanel {
  return {
    id: "panel_1",
    sources: [{ sample: "sample_a", parent: "root" }],
    x: { channel: "FSC-A", scale: "linear" },
    y: { channel: "SSC-A", scale: "linear" },
    position,
    status: { state: "resolved" },
    ...overrides,
  };
}

function layout(overrides: Partial<FlowcytoLayout> = {}): FlowcytoLayout {
  return {
    id: "layout_1",
    name: "Gating strategy",
    kind: "gating_strategy",
    canvas: { width: 612, height: 792 },
    panels: [panel()],
    ...overrides,
  };
}

const codesOf = (result: { errors: Array<{ code: string }> }) => result.errors.map((error) => error.code);

beforeAll(async () => {
  sharedWorkspacePath = await makeLayoutWorkspace();
});

describe("layout storage", () => {
  it("stores a layout, reads it back, and summarizes panel resolution", async () => {
    const workspacePath = await makeLayoutWorkspace();
    const before = await readWorkspace(workspacePath);
    const stored = await upsertLayout({
      workspacePath,
      expectedRevision: before.revision,
      layout: layout({
        panels: [
          panel(),
          panel({
            id: "panel_2",
            status: { state: "unresolved", reason: "unknown_sample", detail: "sampleID=20 has no SampleNode." },
          }),
          panel({
            id: "panel_3",
            status: { state: "unresolved", reason: "ambiguous_path", detail: "Two siblings named Cells.", candidates: ["a1", "a2"] },
          }),
        ],
      }),
    });
    expect(stored.ok).toBe(true);
    expect(stored.revision).toBe(before.revision + 1);
    expect(stored.summary).toEqual({
      total: 3,
      resolved: 1,
      unresolved: 2,
      unresolvedByReason: { unknown_sample: 1, ambiguous_path: 1 },
    });

    const fetched = await getLayout(workspacePath, "layout_1");
    expect(fetched.layout.panels).toHaveLength(3);
    // Unresolved panels are retained verbatim, not dropped.
    expect(fetched.layout.panels[2].status).toEqual({
      state: "unresolved", reason: "ambiguous_path", detail: "Two siblings named Cells.", candidates: ["a1", "a2"],
    });

    const listed = await listLayouts(workspacePath);
    expect(listed.layouts).toHaveLength(1);
    expect(listed.layouts[0]).toMatchObject({ id: "layout_1", kind: "gating_strategy", boundsGroupCount: 0 });
    expect(listed.layouts[0].panels.unresolved).toBe(2);
  });

  it("updates in place by id and rejects a stale revision", async () => {
    const workspacePath = await makeLayoutWorkspace();
    const first = await readWorkspace(workspacePath);
    const created = await upsertLayout({ workspacePath, expectedRevision: first.revision, layout: layout() });
    expect(created.ok).toBe(true);

    const updated = await upsertLayout({
      workspacePath,
      expectedRevision: created.revision as number,
      layout: layout({ name: "Renamed" }),
    });
    expect(updated.ok).toBe(true);
    expect(updated.layoutCount).toBe(1);
    expect((await getLayout(workspacePath, "layout_1")).layout.name).toBe("Renamed");

    const stale = await upsertLayout({ workspacePath, expectedRevision: first.revision, layout: layout() });
    expect(stale.ok).toBe(false);
    expect(codesOf(stale)).toContain("stale_revision");
  });

  it("deletes a layout without disturbing gates", async () => {
    const workspacePath = await makeLayoutWorkspace();
    const before = await readWorkspace(workspacePath);
    const created = await upsertLayout({ workspacePath, expectedRevision: before.revision, layout: layout() });

    const removed = await deleteLayout({
      workspacePath, layoutId: "layout_1", expectedRevision: created.revision as number,
    });
    expect(removed.ok).toBe(true);
    expect(removed.layoutCount).toBe(0);
    expect((await readWorkspace(workspacePath)).gates).toHaveLength(2);

    const missing = await deleteLayout({
      workspacePath, layoutId: "layout_1", expectedRevision: removed.revision as number,
    });
    expect(codesOf(missing)).toContain("unknown_layout");
  });
});

describe("layout validation", () => {
  it("accepts a well-formed layout", async () => {
    const result = await validateLayout({ workspacePath: sharedWorkspacePath, layout: layout() });
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("rejects unknown sample, population, gate and compensation references", async () => {
    const result = await validateLayout({
      workspacePath: sharedWorkspacePath,
      layout: layout({
        panels: [panel({
          sources: [
            { sample: "missing_sample", parent: "root" },
            { sample: "sample_a", parent: "missing_gate" },
            { sample: "sample_a", parent: "root", gate: "missing_overlay" },
            { sample: "sample_a", parent: "root", compensationId: "missing_comp" },
          ],
        })],
      }),
    });
    expect(result.ok).toBe(false);
    expect(codesOf(result)).toEqual([
      "unknown_sample", "unknown_parent_gate", "unknown_gate", "unknown_compensation_id",
    ]);
  });

  it("accepts a quadrant population and a known gate as panel references", async () => {
    const result = await validateLayout({
      workspacePath: sharedWorkspacePath,
      layout: layout({
        panels: [panel({ sources: [{ sample: "sample_a", parent: "lymph", gate: "live", compensationId: "comp_1" }] })],
      }),
    });
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("requires every axis in a bounds group to match its channel and scale", async () => {
    const boundsGroups = [{ id: "fsc", channel: "FSC-A", scale: "linear" as const, bounds: { min: 0, max: 1000 } }];
    const ok = await validateLayout({
      workspacePath: sharedWorkspacePath,
      layout: layout({
        boundsGroups,
        panels: [panel({ x: { channel: "FSC-A", scale: "linear", boundsGroup: "fsc" } })],
      }),
    });
    expect(ok).toEqual({ ok: true, errors: [] });

    const mismatched = await validateLayout({
      workspacePath: sharedWorkspacePath,
      layout: layout({
        boundsGroups,
        panels: [
          panel({ id: "wrong_channel", x: { channel: "SSC-A", scale: "linear", boundsGroup: "fsc" } }),
          panel({ id: "wrong_scale", x: { channel: "FSC-A", scale: "log", boundsGroup: "fsc" } }),
          panel({ id: "no_such_group", x: { channel: "FSC-A", scale: "linear", boundsGroup: "absent" } }),
        ],
      }),
    });
    expect(codesOf(mismatched).sort()).toEqual([
      "bounds_group_channel_mismatch", "bounds_group_scale_mismatch", "unknown_bounds_group",
    ]);
  });

  it("accepts a detector name and its marker alias in one bounds group", async () => {
    // $PnN is FL03-A and $PnS is FITC-A, so both name the same parameter. A stored
    // layout must not be rejected for using the alias: rejection here would mean the
    // layout never reaches a renderer that could reconcile them.
    const result = await validateLayout({
      workspacePath: sharedWorkspacePath,
      layout: layout({
        boundsGroups: [{ id: "fitc", channel: "FITC-A", scale: "linear", bounds: { min: 0, max: 1000 } }],
        panels: [
          panel({ id: "by_detector", x: { channel: "FL03-A", scale: "linear", boundsGroup: "fitc" }, y: undefined, plotType: "histogram" }),
          panel({ id: "by_marker", x: { channel: "FITC-A", scale: "linear", boundsGroup: "fitc" }, y: undefined, plotType: "histogram" }),
        ],
      }),
    });
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("reports an axis channel that no sample parameter resolves to", async () => {
    const result = await validateLayout({
      workspacePath: sharedWorkspacePath,
      layout: layout({ panels: [panel({ x: { channel: "NOT-A-CHANNEL" } })] }),
    });
    expect(codesOf(result)).toEqual(["unknown_parameter"]);
  });

  it("requires transform parameters before sharing bounds under a parameterized scale", async () => {
    const biex = { maxRange: 262144, pos: 4.42, neg: 0, width: 0.5, length: 256 };

    const noGroupParams = await validateLayout({
      workspacePath: sharedWorkspacePath,
      layout: layout({
        boundsGroups: [{ id: "g", channel: "FL03-A", scale: "biex", bounds: { min: 0, max: 1000 } }],
        panels: [panel({ x: { channel: "FL03-A", scale: "biex", transform: biex, boundsGroup: "g" }, y: undefined, plotType: "histogram" })],
      }),
    });
    expect(codesOf(noGroupParams)).toContain("missing_axis_transform");

    const noAxisParams = await validateLayout({
      workspacePath: sharedWorkspacePath,
      layout: layout({
        boundsGroups: [{ id: "g", channel: "FL03-A", scale: "biex", transform: biex, bounds: { min: 0, max: 1000 } }],
        panels: [panel({ x: { channel: "FL03-A", scale: "biex", boundsGroup: "g" }, y: undefined, plotType: "histogram" })],
      }),
    });
    expect(codesOf(noAxisParams)).toEqual(["missing_axis_transform"]);

    const differingParams = await validateLayout({
      workspacePath: sharedWorkspacePath,
      layout: layout({
        boundsGroups: [{ id: "g", channel: "FL03-A", scale: "biex", transform: biex, bounds: { min: 0, max: 1000 } }],
        panels: [panel({
          x: { channel: "FL03-A", scale: "biex", transform: { ...biex, width: 1.5 }, boundsGroup: "g" },
          y: undefined, plotType: "histogram",
        })],
      }),
    });
    expect(codesOf(differingParams)).toEqual(["bounds_group_transform_mismatch"]);

    const matching = await validateLayout({
      workspacePath: sharedWorkspacePath,
      layout: layout({
        boundsGroups: [{ id: "g", channel: "FL03-A", scale: "biex", transform: biex, bounds: { min: 0, max: 1000 } }],
        panels: [panel({ x: { channel: "FL03-A", scale: "biex", transform: biex, boundsGroup: "g" }, y: undefined, plotType: "histogram" })],
      }),
    });
    expect(matching).toEqual({ ok: true, errors: [] });
  });

  it("rejects malformed bounds on an axis and on a group", async () => {
    const result = await validateLayout({
      workspacePath: sharedWorkspacePath,
      layout: layout({
        boundsGroups: [{ id: "bad", channel: "FSC-A", scale: "linear", bounds: { min: 10, max: 10 } }],
        panels: [panel({ x: { channel: "FSC-A", bounds: { min: 5, max: 1 } } })],
      }),
    });
    expect(codesOf(result)).toEqual(["invalid_axis_bounds", "invalid_axis_bounds"]);
  });

  it("requires a typed reason and detail on an unresolved panel", async () => {
    const result = await validateLayout({
      workspacePath: sharedWorkspacePath,
      layout: layout({
        panels: [panel({
          status: { state: "unresolved", reason: "not_a_reason", detail: "" } as unknown as LayoutPanel["status"],
        })],
      }),
    });
    expect(codesOf(result)).toEqual(["invalid_panel_status_reason", "missing_panel_status_detail"]);
  });

  it("rejects a histogram panel that also defines a y axis", async () => {
    const result = await validateLayout({
      workspacePath: sharedWorkspacePath,
      layout: layout({ panels: [panel({ plotType: "histogram" })] }),
    });
    expect(codesOf(result)).toContain("histogram_with_y_axis");

    const histogram = await validateLayout({
      workspacePath: sharedWorkspacePath,
      layout: layout({ panels: [panel({ plotType: "histogram", y: undefined })] }),
    });
    expect(histogram).toEqual({ ok: true, errors: [] });
  });

  it("rejects empty sources, duplicate panel ids and invalid geometry", async () => {
    const result = await validateLayout({
      workspacePath: sharedWorkspacePath,
      layout: layout({
        panels: [
          panel({ id: "dup" }),
          panel({ id: "dup", sources: [] }),
          panel({ id: "bad_box", position: { x: 0, y: 0, width: 0, height: 256 } }),
        ],
      }),
    });
    const codes = codesOf(result);
    expect(codes).toContain("duplicate_panel_id");
    expect(codes).toContain("missing_panel_sources");
    expect(codes).toContain("invalid_panel_position");
  });

  it("rejects an invalid kind and a non-positive canvas", async () => {
    const result = await validateLayout({
      workspacePath: sharedWorkspacePath,
      layout: layout({
        kind: "mosaic" as unknown as FlowcytoLayout["kind"],
        canvas: { width: 0, height: 792 },
      }),
    });
    expect(codesOf(result)).toEqual(["invalid_layout_kind", "invalid_layout_canvas"]);
  });

  it("blocks a workspace write that carries duplicate layout ids", async () => {
    const workspacePath = await makeLayoutWorkspace();
    const workspace = await readWorkspace(workspacePath);
    const result = await writeWorkspace({
      workspacePath,
      expectedRevision: workspace.revision,
      workspace: { ...workspace, layouts: [layout(), layout({ name: "Copy" })] },
    });
    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain("duplicate_layout_id");
  });
});
