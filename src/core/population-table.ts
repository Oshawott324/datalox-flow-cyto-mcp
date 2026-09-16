import path from "node:path";

import { FlowcytoError } from "./types.js";
import { getPopulationGraph, type PopulationGraphNode } from "./population-graph.js";
import { readWorkspace } from "./workspace.js";

export type PopulationTableCell = {
  /** Gate ID that produced this cell — for provenance and tracing back to upsert_gate. */
  gateId: string;
  name: string;
  count: number;
  percentOfParent: number;
  percentOfRoot: number;
};

export type PopulationTableRow = {
  sampleId: string;
  /** Keyed by column key (gateId or name_path). null when the population is absent from this sample. */
  gates: Record<string, PopulationTableCell | null>;
};

export type PopulationTableColumn = {
  /** Stable lookup key matching the keys in PopulationTableRow.gates. */
  key: string;
  /** Leaf gate name for display. */
  name: string;
};

export type PopulationTableResult = {
  ok: true;
  workspacePath: string;
  revision: number;
  compensationId?: string;
  columnKey: "gate_id" | "name_path";
  columns: PopulationTableColumn[];
  rows: PopulationTableRow[];
};

type FlatNode = { node: PopulationGraphNode; namePath: string };

function flattenNodesWithPath(node: PopulationGraphNode, pathParts: string[], out: FlatNode[]): void {
  if (node.gateId === "root") {
    for (const child of node.children) flattenNodesWithPath(child, [], out);
    return;
  }
  const parts = [...pathParts, node.name];
  out.push({ node, namePath: parts.join(" / ") });
  for (const child of node.children) flattenNodesWithPath(child, parts, out);
}

export async function getPopulationTable(input: {
  workspacePath: string;
  sampleIds?: string[];
  gateIds?: string[];
  compensationId?: string;
  columnKey?: "gate_id" | "name_path";
}): Promise<PopulationTableResult> {
  const mode: "gate_id" | "name_path" = input.columnKey ?? "gate_id";
  const workspace = await readWorkspace(input.workspacePath);

  if (input.sampleIds && input.sampleIds.length > 0) {
    const missing = input.sampleIds.filter((id) => !workspace.samples.some((s) => s.id === id));
    if (missing.length > 0) {
      throw new FlowcytoError("unknown_sample", `Sample(s) not found: ${missing.join(", ")}.`, "/sample_ids");
    }
  }

  const samples = input.sampleIds && input.sampleIds.length > 0
    ? workspace.samples.filter((s) => input.sampleIds!.includes(s.id))
    : workspace.samples;

  const graphs = await Promise.all(
    samples.map((s) => getPopulationGraph({
      workspacePath: input.workspacePath,
      sampleId: s.id,
      compensationId: input.compensationId,
    })),
  );

  const gateIdFilter = input.gateIds && input.gateIds.length > 0 ? new Set(input.gateIds) : null;

  // Flatten each sample's tree to (node, namePath), optionally filtered by gateId
  const flattenedPerSample: FlatNode[][] = graphs.map((g) => {
    const flat: FlatNode[] = [];
    flattenNodesWithPath(g.root, [], flat);
    return gateIdFilter ? flat.filter(({ node }) => gateIdFilter.has(node.gateId)) : flat;
  });

  // Collect column keys in first-encounter order across all samples
  const seen = new Set<string>();
  const columnKeys: string[] = [];
  for (const flat of flattenedPerSample) {
    for (const { node, namePath } of flat) {
      const key = mode === "gate_id" ? node.gateId : namePath;
      if (!seen.has(key)) {
        seen.add(key);
        columnKeys.push(key);
      }
    }
  }

  // Column display names
  const gateNameByWorkspace = new Map(workspace.gates.map((g) => [g.id, g.name || g.id]));
  const columns: PopulationTableColumn[] = columnKeys.map((key) => {
    if (mode === "gate_id") {
      return { key, name: gateNameByWorkspace.get(key) ?? key };
    }
    // name_path: last segment of the path is the leaf gate name
    const parts = key.split(" / ");
    return { key, name: parts[parts.length - 1] ?? key };
  });

  // Build rows
  const rows: PopulationTableRow[] = graphs.map((g, si) => {
    const cellByKey = new Map<string, PopulationTableCell>();
    for (const { node, namePath } of flattenedPerSample[si]!) {
      const key = mode === "gate_id" ? node.gateId : namePath;
      cellByKey.set(key, {
        gateId: node.gateId,
        name: node.name,
        count: node.count,
        percentOfParent: node.percentOfParent,
        percentOfRoot: node.percentOfRoot,
      });
    }
    const gates: Record<string, PopulationTableCell | null> = {};
    for (const key of columnKeys) gates[key] = cellByKey.get(key) ?? null;
    return { sampleId: g.sampleId, gates };
  });

  return {
    ok: true,
    workspacePath: path.resolve(input.workspacePath),
    revision: workspace.revision,
    ...(input.compensationId ? { compensationId: input.compensationId } : {}),
    columnKey: mode,
    columns,
    rows,
  };
}
