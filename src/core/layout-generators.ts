import { FlowcytoError, type FlowcytoLayout, type LayoutPanel, type LayoutPanelSource, type PanelAxis } from "./types.js";
import { readWorkspace } from "./workspace.js";
import { validateLayout } from "./layouts.js";
import { populationParentId } from "./gate-model.js";

export type ComparisonPanelInput = {
  source: LayoutPanelSource;
  x: PanelAxis;
  y?: PanelAxis;
  title?: string;
};

type GeneratorOptions = {
  workspacePath: string;
  id: string;
  name: string;
  panelWidth?: number;
  panelHeight?: number;
  gutter?: number;
};

function dimensions(input: GeneratorOptions) {
  const width = input.panelWidth ?? 320;
  const height = input.panelHeight ?? 280;
  const gutter = input.gutter ?? 24;
  if (![width, height, gutter].every(Number.isFinite) || width <= 0 || height <= 0 || gutter < 0) {
    throw new FlowcytoError("invalid_layout_dimensions", "Panel dimensions must be positive and gutter non-negative.");
  }
  return { width, height, gutter };
}

async function finish(input: GeneratorOptions, panels: LayoutPanel[], kind: FlowcytoLayout["kind"], revision: number) {
  if (!panels.length) throw new FlowcytoError("empty_layout", "No panels were selected.");
  const layout: FlowcytoLayout = {
    id: input.id, name: input.name, kind, source: "generated", panels,
    canvas: {
      width: Math.max(...panels.map((panel) => panel.position.x + panel.position.width)),
      height: Math.max(...panels.map((panel) => panel.position.y + panel.position.height)),
    },
  };
  const validation = await validateLayout({ workspacePath: input.workspacePath, layout });
  return { ...validation, layout, expectedRevision: revision,
    limitations: ["Axis ranges are not automatically matched; supply explicit compatible bounds. Biex parameters must belong to the validated reference table.",
      "Independent FlowJo visual and event-membership validation remains pending."],
  };
}

/** Read-only geometry proposal; never changes gates, views, or workspace revision. */
export async function suggestComparisonLayout(input: GeneratorOptions & {
  panels: ComparisonPanelInput[];
  arrangement?: "grid" | "by_sample";
  columns?: number;
}) {
  const workspace = await readWorkspace(input.workspacePath);
  const { width, height, gutter } = dimensions(input);
  const columns = input.columns ?? 3;
  if (!Number.isInteger(columns) || columns < 1) throw new FlowcytoError("invalid_layout_columns", "columns must be a positive integer.");
  const rows = new Map<string, { row: number; count: number }>();
  const panels = input.panels.map((entry, index): LayoutPanel => {
    let row = Math.floor(index / columns);
    let column = index % columns;
    if (input.arrangement === "by_sample") {
      if (!rows.has(entry.source.sample)) rows.set(entry.source.sample, { row: rows.size, count: 0 });
      const group = rows.get(entry.source.sample)!;
      row = group.row;
      column = group.count++;
    }
    return { id: `${input.id}_panel_${index + 1}`, sources: [structuredClone(entry.source)],
      x: structuredClone(entry.x), y: entry.y ? structuredClone(entry.y) : undefined,
      title: entry.title, plotType: entry.y ? "pseudocolor" : "histogram", status: { state: "resolved" },
      position: { x: column * (width + gutter), y: row * (height + gutter), width, height },
    };
  });
  return finish(input, panels, "comparison", workspace.revision);
}

export async function suggestGatingStrategyLayout(input: GeneratorOptions & {
  sampleId: string;
  arrangement?: "linear" | "tree";
  compensationId?: string;
}) {
  const workspace = await readWorkspace(input.workspacePath);
  if (!workspace.samples.some((sample) => sample.id === input.sampleId)) throw new FlowcytoError("unknown_sample", `Unknown sample ${input.sampleId}.`);
  const { width, height, gutter } = dimensions(input);
  const rowCounts = new Map<number, number>();
  const panels = workspace.gates.filter((gate) => gate.sample === input.sampleId).map((gate, index): LayoutPanel => {
    let depth = 0;
    let parent = gate.parent;
    const visited = new Set<string>();
    while (parent !== "root") {
      if (visited.has(parent)) throw new FlowcytoError("invalid_gate_hierarchy", "Cycle in gate ancestry.");
      visited.add(parent);
      const next = populationParentId(workspace, parent);
      if (next === undefined) throw new FlowcytoError("invalid_gate_hierarchy", `Unknown population ${parent}.`);
      parent = next;
      depth++;
    }
    const column = input.arrangement === "tree" ? (rowCounts.get(depth) ?? 0) : 0;
    rowCounts.set(depth, column + 1);
    const row = input.arrangement === "tree" ? depth : index;
    return { id: `${input.id}_panel_${index + 1}`, sources: [{ sample: input.sampleId, parent: gate.parent,
      gate: gate.id, ...(input.compensationId ? { compensationId: input.compensationId } : {}) }],
      x: { channel: gate.x }, y: "y" in gate ? { channel: gate.y } : undefined,
      title: gate.name ?? gate.id, plotType: "y" in gate ? "pseudocolor" : "histogram",
      status: { state: "resolved" }, position: { x: column * (width + gutter), y: row * (height + gutter), width, height },
    };
  });
  return finish(input, panels, "gating_strategy", workspace.revision);
}
