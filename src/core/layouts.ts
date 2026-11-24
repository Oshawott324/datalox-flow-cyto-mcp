import {
  FlowcytoError,
  type FlowcytoLayout,
  type FlowcytoWorkspace,
  type LayoutPanel,
  type PanelUnresolvedReason,
  type ValidationResult,
} from "./types.js";
import { readWorkspace, validateWorkspaceObject, writeWorkspace } from "./workspace.js";

export type LayoutPanelSummary = {
  total: number;
  /** Bound and renderable. */
  resolved: number;
  /** Bound, but not faithfully renderable; see blockedByReason. */
  partial: number;
  /** Not bound to a sample and population. */
  unresolved: number;
  unresolvedByReason: Partial<Record<PanelUnresolvedReason, number>>;
  blockedByReason: Record<string, number>;
};

export type LayoutSummary = {
  id: string;
  name: string;
  kind: FlowcytoLayout["kind"];
  source?: FlowcytoLayout["source"];
  canvas: FlowcytoLayout["canvas"];
  boundsGroupCount: number;
  panels: LayoutPanelSummary;
};

function layoutError(path: string, code: string, message: string): ValidationResult {
  return { ok: false, errors: [{ path, code, message }] };
}

function requireExpectedRevision(expectedRevision: number | undefined): number {
  if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision)) {
    throw new FlowcytoError(
      "missing_expected_revision",
      "Layout edits require expectedRevision so UI and agent writes cannot silently overwrite each other.",
      "/revision",
    );
  }
  return expectedRevision;
}

export function summarizeLayoutPanels(panels: LayoutPanel[]): LayoutPanelSummary {
  const unresolvedByReason: Partial<Record<PanelUnresolvedReason, number>> = {};
  const blockedByReason: Record<string, number> = {};
  let resolved = 0;
  let partial = 0;
  for (const panel of panels) {
    if (panel.status?.state === "unresolved") {
      const reason = panel.status.reason;
      unresolvedByReason[reason] = (unresolvedByReason[reason] ?? 0) + 1;
    } else if (panel.status?.state === "partial") {
      partial += 1;
      for (const blocker of panel.status.blockers) {
        blockedByReason[blocker.reason] = (blockedByReason[blocker.reason] ?? 0) + 1;
      }
    } else {
      resolved += 1;
    }
  }
  return {
    total: panels.length,
    resolved,
    partial,
    unresolved: panels.length - resolved - partial,
    unresolvedByReason,
    blockedByReason,
  };
}

export function summarizeLayout(layout: FlowcytoLayout): LayoutSummary {
  return {
    id: layout.id,
    name: layout.name,
    kind: layout.kind,
    ...(layout.source ? { source: layout.source } : {}),
    canvas: layout.canvas,
    boundsGroupCount: layout.boundsGroups?.length ?? 0,
    panels: summarizeLayoutPanels(Array.isArray(layout.panels) ? layout.panels : []),
  };
}

export async function listLayouts(workspacePath: string): Promise<{
  ok: true;
  workspacePath: string;
  revision: number;
  layouts: LayoutSummary[];
}> {
  const workspace = await readWorkspace(workspacePath);
  return {
    ok: true,
    workspacePath,
    revision: workspace.revision,
    layouts: (workspace.layouts ?? []).map(summarizeLayout),
  };
}

export async function getLayout(workspacePath: string, layoutId: string): Promise<{
  ok: true;
  workspacePath: string;
  revision: number;
  layout: FlowcytoLayout;
  summary: LayoutPanelSummary;
}> {
  const workspace = await readWorkspace(workspacePath);
  const layout = (workspace.layouts ?? []).find((entry) => entry.id === layoutId);
  if (!layout) {
    throw new FlowcytoError("unknown_layout", `Layout ${layoutId} is not present.`, "/layouts");
  }
  return {
    ok: true,
    workspacePath,
    revision: workspace.revision,
    layout,
    summary: summarizeLayoutPanels(Array.isArray(layout.panels) ? layout.panels : []),
  };
}

// Validates a candidate layout against the current workspace without writing.
// The candidate is validated alone at /layouts/0 so reported paths are stable and
// unrelated layouts cannot mask or add errors.
export async function validateLayout(params: {
  workspacePath: string;
  layout: FlowcytoLayout;
}): Promise<ValidationResult> {
  const workspace = await readWorkspace(params.workspacePath);
  const candidate: FlowcytoWorkspace = { ...workspace, layouts: [params.layout] };
  return validateWorkspaceObject(params.workspacePath, candidate);
}

export async function upsertLayout(params: {
  workspacePath: string;
  layout: FlowcytoLayout;
  expectedRevision: number;
}): Promise<ValidationResult & {
  revision?: number;
  layout?: FlowcytoLayout;
  layoutCount?: number;
  summary?: LayoutPanelSummary;
  workspacePath?: string;
}> {
  const expectedRevision = requireExpectedRevision(params.expectedRevision);
  if (!params.layout?.id) {
    return layoutError("/layout/id", "missing_layout_id", "Layout id is required.");
  }
  const workspace = await readWorkspace(params.workspacePath);
  const layouts = [...(workspace.layouts ?? [])];
  const existingIndex = layouts.findIndex((entry) => entry.id === params.layout.id);
  if (existingIndex === -1) layouts.push(params.layout);
  else layouts[existingIndex] = params.layout;

  const next: FlowcytoWorkspace = { ...workspace, layouts };
  const result = await writeWorkspace({ workspacePath: params.workspacePath, workspace: next, expectedRevision });
  return result.ok
    ? {
      ...result,
      layout: params.layout,
      layoutCount: layouts.length,
      summary: summarizeLayoutPanels(Array.isArray(params.layout.panels) ? params.layout.panels : []),
      workspacePath: params.workspacePath,
    }
    : result;
}

export async function deleteLayout(params: {
  workspacePath: string;
  layoutId: string;
  expectedRevision: number;
}): Promise<ValidationResult & {
  revision?: number;
  layoutId?: string;
  layoutCount?: number;
  workspacePath?: string;
}> {
  const expectedRevision = requireExpectedRevision(params.expectedRevision);
  const workspace = await readWorkspace(params.workspacePath);
  const layouts = workspace.layouts ?? [];
  if (!layouts.some((entry) => entry.id === params.layoutId)) {
    return layoutError("/layouts", "unknown_layout", `Layout ${params.layoutId} is not present.`);
  }
  const next: FlowcytoWorkspace = {
    ...workspace,
    layouts: layouts.filter((entry) => entry.id !== params.layoutId),
  };
  const result = await writeWorkspace({ workspacePath: params.workspacePath, workspace: next, expectedRevision });
  return result.ok
    ? {
      ...result,
      layoutId: params.layoutId,
      layoutCount: next.layouts?.length ?? 0,
      workspacePath: params.workspacePath,
    }
    : result;
}
