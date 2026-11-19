import { promises as fs } from "node:fs";
import path from "node:path";

import {
  FlowcytoError,
  getLayout,
  resolveWorkspaceRoot,
  type AppliedCompensation,
  type FlowcytoLayout,
  type LayoutPanel,
  type PreviewFormat,
} from "../../core/index.js";
import { getRenderablePlotContext, type RenderablePlotContext } from "./server.js";
import { renderPlotSvg, type PlotImageOutput } from "./plot-image.js";

/**
 * How a layout's recorded compensation is treated when rendering.
 *
 * This is an explicit input, not an inference from whether some argument was
 * passed: "as_recorded" applies exactly the compensationId each source stores,
 * and "none" renders every source raw. Either way the result reports, per
 * source, what was actually applied.
 */
export type LayoutCompensationMode = "as_recorded" | "none";

export const DEFAULT_MAX_LAYOUT_PANELS = 64;

export type LayoutImageOptions = {
  workspacePath: string;
  layoutId: string;
  compensation?: LayoutCompensationMode;
  maxEvents?: number;
  format?: PreviewFormat;
  binWidth?: number;
  binHeight?: number;
  output?: PlotImageOutput;
  outputPath?: string;
  maxPanels?: number;
  /** Omit the composited SVG; used by the agent-readable render_layout path. */
  withoutImage?: boolean;
};

export type LayoutSourceReport = {
  sample: string;
  parent: string;
  /** The compensationId the layout records for this source, if any. */
  recordedCompensationId?: string;
  /** An explicit reference the import could not bind. */
  unresolvedCompensation?: { reference: string; detail: string };
  /** What the renderer actually applied, straight from the preview pipeline. */
  applied: AppliedCompensation;
};

export type LayoutPanelReport = {
  id: string;
  state: "rendered" | "placeholder";
  position: LayoutPanel["position"];
  /** Why a placeholder was drawn instead of a plot. */
  reason?: string;
  x?: string;
  y?: string;
  scale?: { x: string; y: string };
  sources?: LayoutSourceReport[];
  previewSummary?: RenderablePlotContext["previewSummary"];
  gateCount?: number;
};

export type RenderedLayout = {
  ok: true;
  workspacePath: string;
  revision: number;
  layoutId: string;
  layoutName: string;
  kind: FlowcytoLayout["kind"];
  compensationMode: LayoutCompensationMode;
  canvas: { width: number; height: number };
  rendered: number;
  placeholders: number;
  panels: LayoutPanelReport[];
  image?: {
    format: "svg";
    mimeType: "image/svg+xml";
    width: number;
    height: number;
    bytes: number;
    svg: string;
    path?: string;
  };
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fixed(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : "0";
}

/**
 * Places a standalone panel SVG on the layout canvas.
 *
 * Only the root element's x/y/width/height are rewritten; the viewBox and every
 * child element are left exactly as renderPlotSvg produced them. A nested <svg>
 * establishes its own viewport, so the panel scales into its slot and its
 * content stays byte-identical to the standalone render of the same inputs.
 */
function placePanelSvg(svg: string, panel: LayoutPanel): string {
  const open = svg.indexOf(">");
  if (!svg.startsWith("<svg ") || open === -1) {
    throw new FlowcytoError("invalid_panel_svg", "Panel SVG did not start with an <svg> element.", "/panels");
  }
  const root = svg.slice(0, open);
  const rest = svg.slice(open);
  const rewritten = root
    .replace(/\swidth="[^"]*"/, "")
    .replace(/\sheight="[^"]*"/, "")
    + ` x="${fixed(panel.position.x)}" y="${fixed(panel.position.y)}"`
    + ` width="${fixed(panel.position.width)}" height="${fixed(panel.position.height)}"`;
  return rewritten + rest;
}

function wrapLabel(text: string, perLine: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length > 0 && line.length + word.length + 1 > perLine) {
      lines.push(line);
      line = "";
      if (lines.length === maxLines) return lines;
    }
    line = line.length > 0 ? `${line} ${word}` : word;
  }
  if (line.length > 0 && lines.length < maxLines) lines.push(line);
  return lines;
}

/** A visibly non-plot slot. It never resembles rendered data. */
function renderPlaceholder(panel: LayoutPanel, title: string, reason: string): string {
  const { x, y, width, height } = panel.position;
  const perLine = Math.max(16, Math.floor(width / 7));
  const lines = wrapLabel(reason, perLine, 6);
  const body = lines
    .map((line, index) =>
      `<text x="${fixed(x + 12)}" y="${fixed(y + 54 + index * 15)}" font-size="11" fill="#7a5230">${escapeXml(line)}</text>`)
    .join("");
  return [
    `<g>`,
    `<rect x="${fixed(x)}" y="${fixed(y)}" width="${fixed(width)}" height="${fixed(height)}"`,
    ` fill="#fdf6ec" stroke="#b4824a" stroke-width="1.5" stroke-dasharray="6 4"/>`,
    `<text x="${fixed(x + 12)}" y="${fixed(y + 24)}" font-size="12" font-weight="600" fill="#7a5230">${escapeXml(title)}</text>`,
    `<text x="${fixed(x + 12)}" y="${fixed(y + 40)}" font-size="11" font-weight="600" fill="#b4824a">NOT RENDERED</text>`,
    body,
    `</g>`,
  ].join("");
}

/** Why a bound panel still cannot be drawn. */
function placeholderReason(panel: LayoutPanel): string | null {
  if (panel.status.state === "unresolved") {
    return `${panel.status.reason}: ${panel.status.detail}`;
  }
  if (panel.status.state === "partial") {
    return panel.status.blockers.map((blocker) => `${blocker.reason}: ${blocker.detail}`).join(" ");
  }
  if (panel.sources.length > 1) {
    return `overlay_not_supported: this panel overlays ${panel.sources.length} sources, which the layout renderer does not draw yet.`;
  }
  if (!panel.y) {
    return "histogram_not_supported: one-dimensional panels are not drawn by the layout renderer yet.";
  }
  return null;
}

function canvasFor(layout: FlowcytoLayout): { width: number; height: number } {
  // Panels may sit outside the page box: the reference workspace places them at
  // x up to 1287 inside a 612-wide PrintLayout. Grow the canvas rather than clip.
  let width = layout.canvas.width;
  let height = layout.canvas.height;
  for (const panel of layout.panels) {
    width = Math.max(width, panel.position.x + panel.position.width);
    height = Math.max(height, panel.position.y + panel.position.height);
  }
  return { width: Math.ceil(width) + 16, height: Math.ceil(height) + 16 };
}

async function writeLayoutFile(workspacePath: string, layoutId: string, revision: number, svg: string, outputPath?: string): Promise<string> {
  const root = resolveWorkspaceRoot(workspacePath);
  const target = outputPath
    ? path.resolve(outputPath)
    : path.join(root, ".datalox", "cache", "layouts", `${layoutId.replace(/[^A-Za-z0-9._-]+/g, "_")}_rev${revision}.svg`);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new FlowcytoError(
      "layout_output_path_outside_workspace",
      "render_layout_image output_path must be inside the workspace root.",
      "/output_path",
    );
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, svg, "utf8");
  return target;
}

export async function renderLayout(options: LayoutImageOptions): Promise<RenderedLayout> {
  const { layout, revision } = await getLayout(options.workspacePath, options.layoutId);
  const maxPanels = options.maxPanels ?? DEFAULT_MAX_LAYOUT_PANELS;
  if (layout.panels.length > maxPanels) {
    throw new FlowcytoError(
      "layout_too_many_panels",
      `Layout ${layout.id} has ${layout.panels.length} panels, above the ${maxPanels} panel limit. Raise max_panels deliberately if this is intended.`,
      "/panels",
    );
  }
  const mode: LayoutCompensationMode = options.compensation ?? "as_recorded";
  const canvas = canvasFor(layout);
  const body: string[] = [];
  const reports: LayoutPanelReport[] = [];
  let rendered = 0;

  for (const panel of layout.panels) {
    const reason = placeholderReason(panel);
    if (reason) {
      body.push(renderPlaceholder(panel, panel.id, reason));
      reports.push({ id: panel.id, state: "placeholder", position: panel.position, reason });
      continue;
    }
    const source = panel.sources[0];
    // "as_recorded" applies exactly what the layout stores; "none" renders raw.
    const compensationId = mode === "as_recorded" ? source.compensationId : undefined;
    let context: RenderablePlotContext;
    try {
      context = await getRenderablePlotContext({
        workspacePath: options.workspacePath,
        sampleId: source.sample,
        parent: source.parent,
        x: panel.x.channel,
        y: panel.y?.channel,
        maxEvents: options.maxEvents,
        format: options.format,
        binWidth: options.binWidth,
        binHeight: options.binHeight,
        compensationId,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const failed = `render_failed: ${detail}`;
      body.push(renderPlaceholder(panel, panel.id, failed));
      reports.push({ id: panel.id, state: "placeholder", position: panel.position, reason: failed });
      continue;
    }

    const svg = renderPlotSvg(context, panel.position.width, panel.position.height);
    body.push(placePanelSvg(svg, panel));
    rendered += 1;
    reports.push({
      id: panel.id,
      state: "rendered",
      position: panel.position,
      x: context.x,
      y: context.y,
      scale: { x: context.scale.x, y: context.scale.y },
      gateCount: context.gates.length,
      previewSummary: context.previewSummary,
      sources: [{
        sample: source.sample,
        parent: source.parent,
        ...(source.compensationId ? { recordedCompensationId: source.compensationId } : {}),
        ...(source.unresolvedCompensation ? { unresolvedCompensation: source.unresolvedCompensation } : {}),
        applied: context.previewSummary.compensation ?? { applied: false },
      }],
    });
  }

  const result: RenderedLayout = {
    ok: true,
    workspacePath: options.workspacePath,
    revision,
    layoutId: layout.id,
    layoutName: layout.name,
    kind: layout.kind,
    compensationMode: mode,
    canvas,
    rendered,
    placeholders: layout.panels.length - rendered,
    panels: reports,
  };
  if (options.withoutImage) return result;

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}"`,
    ` viewBox="0 0 ${canvas.width} ${canvas.height}" role="img"`,
    ` aria-label="${escapeXml(layout.name)} layout with ${rendered} rendered panels and ${layout.panels.length - rendered} placeholders">`,
    `<rect width="100%" height="100%" fill="#f4f6f8"/>`,
    ...body,
    `</svg>`,
  ].join("");

  const output = options.output ?? "both";
  const filePath = output === "file" || output === "both"
    ? await writeLayoutFile(options.workspacePath, layout.id, revision, svg, options.outputPath)
    : undefined;

  return {
    ...result,
    image: {
      format: "svg",
      mimeType: "image/svg+xml",
      width: canvas.width,
      height: canvas.height,
      bytes: Buffer.byteLength(svg, "utf8"),
      svg: output === "file" ? "" : svg,
      ...(filePath ? { path: filePath } : {}),
    },
  };
}
