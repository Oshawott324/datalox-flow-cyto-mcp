import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  densityColor,
  formatTick,
  generateTicks,
  inverseTransformValue,
  rgbaCss,
  resolveWorkspaceRoot,
  transformPoint,
  FlowcytoError,
  type PlotBounds,
  type WorkspaceGate,
} from "../../core/index.js";
import { getRenderablePlotContext, type PlotContextOptions, type RenderablePlotContext } from "./server.js";

export type PlotImageFormat = "svg";
export type PlotImageOutput = "content" | "file" | "both";

export type PlotImageOptions = PlotContextOptions & {
  width?: number;
  height?: number;
  imageFormat?: PlotImageFormat;
  output?: PlotImageOutput;
  outputPath?: string;
};

export type RenderedPlotImage = {
  ok: true;
  workspacePath: string;
  revision: number;
  sampleId: string;
  x: string;
  y: string;
  compensation?: RenderablePlotContext["previewSummary"]["compensation"];
  image: {
    format: PlotImageFormat;
    mimeType: "image/svg+xml";
    width: number;
    height: number;
    bytes: number;
    svg: string;
    path?: string;
  };
  previewSummary: RenderablePlotContext["previewSummary"];
};

type PlotArea = {
  left: number;
  top: number;
  width: number;
  height: number;
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fixed(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits).replace(/\.?0+$/, "") : "0";
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function safeName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned : "plot";
}

function assertInsideWorkspace(workspacePath: string, outputPath: string): string {
  const root = resolveWorkspaceRoot(workspacePath);
  const resolved = path.resolve(outputPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new FlowcytoError(
      "plot_output_path_outside_workspace",
      "render_plot_image output_path must be inside the workspace root.",
      "/output_path",
    );
  }
  return resolved;
}

function defaultPlotPath(context: RenderablePlotContext, svg: string): string {
  const root = resolveWorkspaceRoot(context.workspacePath);
  const file = [
    safeName(context.sampleId),
    safeName(context.x),
    "vs",
    safeName(context.y),
    `rev${context.revision}`,
    digest(svg),
  ].join("_");
  return path.join(root, ".datalox", "cache", "plots", `${file}.svg`);
}

async function writePlotFile(context: RenderablePlotContext, svg: string, outputPath?: string): Promise<string> {
  const target = outputPath
    ? assertInsideWorkspace(context.workspacePath, outputPath)
    : defaultPlotPath(context, svg);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, svg, "utf8");
  return target;
}

function visualToSvg(point: [number, number], bounds: PlotBounds, area: PlotArea): [number, number] {
  const x = area.left + ((point[0] - bounds.xMin) / (bounds.xMax - bounds.xMin)) * area.width;
  const y = area.top + area.height - ((point[1] - bounds.yMin) / (bounds.yMax - bounds.yMin)) * area.height;
  return [x, y];
}

function dataToSvg(
  point: [number, number],
  context: RenderablePlotContext,
  area: PlotArea,
): [number, number] {
  return visualToSvg(transformPoint(point, context.scale), context.visualBounds, area);
}

function renderGridAndAxes(context: RenderablePlotContext, area: PlotArea): string[] {
  const parts: string[] = [];
  const xTicks = generateTicks(context.visualBounds.xMin, context.visualBounds.xMax, 6);
  const yTicks = generateTicks(context.visualBounds.yMin, context.visualBounds.yMax, 6);

  for (const tick of xTicks) {
    const [x] = visualToSvg([tick, context.visualBounds.yMin], context.visualBounds, area);
    parts.push(`<line x1="${fixed(x)}" y1="${area.top}" x2="${fixed(x)}" y2="${area.top + area.height}" stroke="#e8edf2" stroke-width="1"/>`);
  }
  for (const tick of yTicks) {
    const [, y] = visualToSvg([context.visualBounds.xMin, tick], context.visualBounds, area);
    parts.push(`<line x1="${area.left}" y1="${fixed(y)}" x2="${area.left + area.width}" y2="${fixed(y)}" stroke="#e8edf2" stroke-width="1"/>`);
  }

  parts.push(`<rect x="${area.left}" y="${area.top}" width="${area.width}" height="${area.height}" fill="none" stroke="#293241" stroke-width="1.2"/>`);

  for (const tick of xTicks) {
    const [x] = visualToSvg([tick, context.visualBounds.yMin], context.visualBounds, area);
    const label = formatTick(inverseTransformValue(tick, context.scale.x));
    parts.push(`<text x="${fixed(x)}" y="${area.top + area.height + 20}" text-anchor="middle" font-size="11" fill="#5b6570">${escapeXml(label)}</text>`);
  }
  for (const tick of yTicks) {
    const [, y] = visualToSvg([context.visualBounds.xMin, tick], context.visualBounds, area);
    const label = formatTick(inverseTransformValue(tick, context.scale.y));
    parts.push(`<text x="${area.left - 8}" y="${fixed(y + 4)}" text-anchor="end" font-size="11" fill="#5b6570">${escapeXml(label)}</text>`);
  }
  return parts;
}

function renderBins(context: RenderablePlotContext, area: PlotArea): string[] {
  const bins = context.preview.bins;
  if (!bins || bins.counts.length === 0) return [];
  const maxCount = bins.counts.reduce((max, count) => Math.max(max, count), 0);
  if (maxCount === 0) return [];
  const maxLog = Math.log1p(maxCount);
  const xStep = (bins.xMax - bins.xMin) / bins.width;
  const yStep = (bins.yMax - bins.yMin) / bins.height;
  const parts: string[] = [];
  for (let yIndex = 0; yIndex < bins.height; yIndex += 1) {
    for (let xIndex = 0; xIndex < bins.width; xIndex += 1) {
      const count = bins.counts[yIndex * bins.width + xIndex] ?? 0;
      if (count === 0) continue;
      const x0 = bins.xMin + xIndex * xStep;
      const x1 = x0 + xStep;
      const y0 = bins.yMin + yIndex * yStep;
      const y1 = y0 + yStep;
      const a = dataToSvg([x0, y0], context, area);
      const b = dataToSvg([x1, y1], context, area);
      const left = Math.max(area.left, Math.min(a[0], b[0]));
      const right = Math.min(area.left + area.width, Math.max(a[0], b[0]));
      const top = Math.max(area.top, Math.min(a[1], b[1]));
      const bottom = Math.min(area.top + area.height, Math.max(a[1], b[1]));
      if (right <= left || bottom <= top) continue;
      const color = rgbaCss(densityColor(Math.log1p(count) / maxLog, "pseudocolor"));
      parts.push(`<rect x="${fixed(left)}" y="${fixed(top)}" width="${fixed(Math.max(1, right - left))}" height="${fixed(Math.max(1, bottom - top))}" fill="${color}"/>`);
    }
  }
  return parts;
}

function renderPoints(context: RenderablePlotContext, area: PlotArea): string[] {
  const points = context.preview.points ?? [];
  return points.map((point) => {
    const [x, y] = dataToSvg(point, context, area);
    return `<circle cx="${fixed(x, 1)}" cy="${fixed(y, 1)}" r="1.2" fill="rgba(38,70,83,0.42)"/>`;
  });
}

function renderGate(gate: WorkspaceGate, context: RenderablePlotContext, area: PlotArea): string | null {
  if (gate.type === "polygon") {
    const points = gate.vertices.map((point) => {
      const [x, y] = dataToSvg(point, context, area);
      return `${fixed(x)},${fixed(y)}`;
    }).join(" ");
    if (!points) return null;
    return `<polygon points="${points}" fill="rgba(19,111,99,0.08)" stroke="#136f63" stroke-width="2"/>`;
  }
  if (gate.type === "rect") {
    const a = dataToSvg([gate.xMin, gate.yMin], context, area);
    const b = dataToSvg([gate.xMax, gate.yMax], context, area);
    const x = Math.min(a[0], b[0]);
    const y = Math.min(a[1], b[1]);
    return `<rect x="${fixed(x)}" y="${fixed(y)}" width="${fixed(Math.abs(b[0] - a[0]))}" height="${fixed(Math.abs(b[1] - a[1]))}" fill="rgba(19,111,99,0.08)" stroke="#136f63" stroke-width="2"/>`;
  }
  return null;
}

export function renderPlotSvg(context: RenderablePlotContext, width = 760, height = 560): string {
  const safeWidth = Math.max(320, Math.min(2000, Math.floor(width)));
  const safeHeight = Math.max(260, Math.min(1600, Math.floor(height)));
  const area: PlotArea = {
    left: 74,
    top: 48,
    width: safeWidth - 104,
    height: safeHeight - 104,
  };
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${safeWidth}" height="${safeHeight}" viewBox="0 0 ${safeWidth} ${safeHeight}" role="img" aria-label="${escapeXml(context.xLabel)} versus ${escapeXml(context.yLabel)}">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<text x="${area.left}" y="24" font-size="16" font-weight="600" fill="#1f2933">${escapeXml(context.sampleId)}: ${escapeXml(context.xLabel)} vs ${escapeXml(context.yLabel)}</text>`,
    `<text x="${safeWidth - 18}" y="24" text-anchor="end" font-size="11" fill="#6b7280">events ${context.previewSummary.sampledEvents}/${context.previewSummary.filteredEvents}</text>`,
    `<defs><clipPath id="plotClip"><rect x="${area.left}" y="${area.top}" width="${area.width}" height="${area.height}"/></clipPath></defs>`,
    ...renderGridAndAxes(context, area),
    `<g clip-path="url(#plotClip)">`,
    ...(context.preview.bins ? renderBins(context, area) : renderPoints(context, area)),
    ...context.gates.map((gate) => renderGate(gate, context, area)).filter((value): value is string => value !== null),
    `</g>`,
    `<text x="${area.left + area.width / 2}" y="${safeHeight - 18}" text-anchor="middle" font-size="13" fill="#374151">${escapeXml(context.xLabel)}</text>`,
    `<text transform="translate(18 ${area.top + area.height / 2}) rotate(-90)" text-anchor="middle" font-size="13" fill="#374151">${escapeXml(context.yLabel)}</text>`,
    `</svg>`,
  ];
  return parts.join("");
}

export async function renderPlotImage(options: PlotImageOptions): Promise<RenderedPlotImage> {
  const context = await getRenderablePlotContext({
    workspacePath: options.workspacePath,
    sampleId: options.sampleId,
    parent: options.parent,
    x: options.x,
    y: options.y,
    maxEvents: options.maxEvents,
    format: options.format,
    binWidth: options.binWidth,
    binHeight: options.binHeight,
    compensationId: options.compensationId,
  });
  const width = options.width ?? 760;
  const height = options.height ?? 560;
  const svg = renderPlotSvg(context, width, height);
  const output = options.output ?? "both";
  const filePath = output === "file" || output === "both"
    ? await writePlotFile(context, svg, options.outputPath)
    : undefined;
  return {
    ok: true,
    workspacePath: context.workspacePath,
    revision: context.revision,
    sampleId: context.sampleId,
    x: context.x,
    y: context.y,
    ...(context.previewSummary.compensation ? { compensation: context.previewSummary.compensation } : {}),
    image: {
      format: "svg",
      mimeType: "image/svg+xml",
      width: Math.max(320, Math.min(2000, Math.floor(width))),
      height: Math.max(260, Math.min(1600, Math.floor(height))),
      bytes: Buffer.byteLength(svg, "utf8"),
      svg,
      ...(filePath ? { path: filePath } : {}),
    },
    previewSummary: context.previewSummary,
  };
}
