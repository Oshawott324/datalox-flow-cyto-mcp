import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { DEFAULT_BIN_HEIGHT, DEFAULT_BIN_WIDTH, type BuildEventPreviewInput } from "./preview-build.js";
import {
  FlowcytoError,
  type EventPreview,
  type PreviewFormat,
} from "./types.js";
import { readWorkspace, resolveSamplePath, resolveWorkspaceRoot } from "./workspace.js";

const PREVIEW_CACHE_VERSION = 1;

type CachedPreviewMeta = {
  version: 1;
  key: string;
  createdAt: string;
  preview: Omit<EventPreview, "points" | "bins"> & {
    points?: { count: number };
    bins?: Omit<NonNullable<EventPreview["bins"]>, "counts">;
  };
  binary: {
    encoding: "float64-points" | "uint32-bins";
    byteLength: number;
  };
};

type WorkerResponse = {
  id: string;
  ok: boolean;
  preview?: EventPreview;
  error?: { code: string; message: string; path?: string };
};

export type GetEventPreviewInput = {
  workspacePath: string;
  sampleId: string;
  x: string;
  y: string;
  parent?: string;
  maxEvents?: number;
  format?: PreviewFormat;
  binWidth?: number;
  binHeight?: number;
};

function normalizePositiveInteger(value: number | undefined, fallback: number, pathValue: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new FlowcytoError("invalid_positive_integer", `${pathValue} must be a positive integer.`, pathValue);
  }
  return value;
}

function normalizeFormat(format: PreviewFormat | undefined): PreviewFormat {
  if (format === undefined) return "auto";
  if (format !== "auto" && format !== "points" && format !== "bins") {
    throw new FlowcytoError("invalid_preview_format", "Preview format must be auto, points, or bins.", "/format");
  }
  return format;
}

async function fileFingerprint(filePath: string): Promise<Record<string, unknown>> {
  const stat = await fs.stat(filePath);
  return {
    path: path.resolve(filePath),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

function previewCacheDir(workspacePath: string): string {
  return path.join(resolveWorkspaceRoot(workspacePath), ".datalox", "cache", "previews");
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function previewCacheKey(input: {
  workspacePath: string;
  workspaceRevision: number;
  samplePath: string;
  sampleId: string;
  x: string;
  y: string;
  parent: string;
  maxEvents: number;
  format: PreviewFormat;
  binWidth: number;
  binHeight: number;
}): Promise<string> {
  return digest({
    version: PREVIEW_CACHE_VERSION,
    parser: "flowcyto-fcs-ts-v1",
    workspaceRevision: input.workspaceRevision,
    sample: await fileFingerprint(input.samplePath),
    sampleId: input.sampleId,
    x: input.x,
    y: input.y,
    parent: input.parent,
    maxEvents: input.maxEvents,
    format: input.format,
    binWidth: input.binWidth,
    binHeight: input.binHeight,
  });
}

async function atomicWriteFile(filePath: string, content: Buffer | string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temp, content);
  await fs.rename(temp, filePath);
}

function cachePaths(workspacePath: string, key: string): { jsonPath: string; binPath: string } {
  const dir = previewCacheDir(workspacePath);
  return {
    jsonPath: path.join(dir, `${key}.json`),
    binPath: path.join(dir, `${key}.bin`),
  };
}

function previewToCacheMeta(preview: EventPreview, key: string, binByteLength: number): CachedPreviewMeta {
  if (preview.format === "bins" && preview.bins) {
    const { counts: _counts, ...bins } = preview.bins;
    return {
      version: PREVIEW_CACHE_VERSION,
      key,
      createdAt: new Date().toISOString(),
      preview: { ...preview, bins, points: undefined },
      binary: { encoding: "uint32-bins", byteLength: binByteLength },
    };
  }
  return {
    version: PREVIEW_CACHE_VERSION,
    key,
    createdAt: new Date().toISOString(),
    preview: { ...preview, points: { count: preview.points?.length ?? 0 }, bins: undefined },
    binary: { encoding: "float64-points", byteLength: binByteLength },
  };
}

function previewBinary(preview: EventPreview): Buffer {
  if (preview.format === "bins" && preview.bins) {
    const values = new Uint32Array(preview.bins.counts);
    return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
  }
  const points = preview.points ?? [];
  const values = new Float64Array(points.length * 2);
  points.forEach((point, index) => {
    values[index * 2] = point[0];
    values[index * 2 + 1] = point[1];
  });
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

async function writePreviewCache(workspacePath: string, key: string, preview: EventPreview): Promise<void> {
  const { jsonPath, binPath } = cachePaths(workspacePath, key);
  const binary = previewBinary(preview);
  const meta = previewToCacheMeta(preview, key, binary.byteLength);
  await atomicWriteFile(binPath, binary);
  await atomicWriteFile(jsonPath, `${JSON.stringify(meta, null, 2)}\n`);
}

function arrayBufferFor(buffer: Buffer): ArrayBuffer {
  const copy = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(copy).set(buffer);
  return copy;
}

async function readPreviewCache(workspacePath: string, key: string): Promise<EventPreview | null> {
  const { jsonPath, binPath } = cachePaths(workspacePath, key);
  let meta: CachedPreviewMeta;
  let binary: Buffer;
  try {
    meta = JSON.parse(await fs.readFile(jsonPath, "utf8")) as CachedPreviewMeta;
    binary = await fs.readFile(binPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
  if (meta.version !== PREVIEW_CACHE_VERSION || meta.key !== key || meta.binary.byteLength !== binary.byteLength) return null;

  if (meta.binary.encoding === "uint32-bins" && meta.preview.bins) {
    const counts = Array.from(new Uint32Array(arrayBufferFor(binary)));
    return {
      sampleId: meta.preview.sampleId,
      x: meta.preview.x,
      y: meta.preview.y,
      parent: meta.preview.parent,
      format: "bins",
      scale: meta.preview.scale,
      totalEvents: meta.preview.totalEvents,
      sampledEvents: meta.preview.sampledEvents,
      bins: { ...meta.preview.bins, counts },
    };
  }

  if (meta.binary.encoding === "float64-points" && meta.preview.points) {
    const values = new Float64Array(arrayBufferFor(binary));
    const points: Array<[number, number]> = [];
    for (let index = 0; index + 1 < values.length; index += 2) {
      points.push([values[index], values[index + 1]]);
    }
    if (points.length !== meta.preview.points.count) return null;
    return {
      sampleId: meta.preview.sampleId,
      x: meta.preview.x,
      y: meta.preview.y,
      parent: meta.preview.parent,
      format: "points",
      scale: meta.preview.scale,
      totalEvents: meta.preview.totalEvents,
      sampledEvents: meta.preview.sampledEvents,
      points,
    };
  }
  return null;
}

function deserializeWorkerError(error: WorkerResponse["error"]): FlowcytoError {
  if (!error) return new FlowcytoError("preview_worker_failed", "Preview worker failed without a structured error.", "/");
  return new FlowcytoError(error.code, error.message, error.path);
}

async function previewWorkerUrl(): Promise<URL> {
  const colocated = new URL("./preview-worker.js", import.meta.url);
  try {
    await fs.access(fileURLToPath(colocated));
    return colocated;
  } catch {
    const built = path.resolve(process.cwd(), "dist/src/core/preview-worker.js");
    await fs.access(built);
    return pathToFileURL(built);
  }
}

async function runPreviewWorker(input: BuildEventPreviewInput): Promise<EventPreview> {
  const id = randomUUID();
  const worker = new Worker(await previewWorkerUrl());
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      if (!settled) return;
      void worker.terminate();
    };
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const onMessage = (message: WorkerResponse) => {
      if (message.id !== id) return;
      finish(() => {
        if (message.ok && message.preview) resolve(message.preview);
        else reject(deserializeWorkerError(message.error));
      });
    };
    const onError = (error: Error) => {
      finish(() => reject(new FlowcytoError("preview_worker_failed", error.message, "/")));
    };
    const onExit = (code: number) => {
      if (settled) return;
      reject(new FlowcytoError("preview_worker_exited", `Preview worker exited before returning a preview with code ${code}.`, "/"));
    };
    worker.on("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
    worker.postMessage({ id, input });
  });
}

export async function getEventPreview(params: GetEventPreviewInput): Promise<EventPreview> {
  const workspace = await readWorkspace(params.workspacePath);
  const sample = workspace.samples.find((entry) => entry.id === params.sampleId);
  if (!sample) throw new FlowcytoError("unknown_sample", `Sample ${params.sampleId} is not present.`, "/sample_id");

  const maxEvents = normalizePositiveInteger(params.maxEvents, 10_000, "/max_events");
  const binWidth = normalizePositiveInteger(params.binWidth, DEFAULT_BIN_WIDTH, "/bin_width");
  const binHeight = normalizePositiveInteger(params.binHeight, DEFAULT_BIN_HEIGHT, "/bin_height");
  const format = normalizeFormat(params.format);
  const parent = params.parent ?? "root";
  const samplePath = resolveSamplePath(params.workspacePath, sample.path);
  const key = await previewCacheKey({
    workspacePath: params.workspacePath,
    workspaceRevision: workspace.revision,
    samplePath,
    sampleId: params.sampleId,
    x: params.x,
    y: params.y,
    parent,
    maxEvents,
    format,
    binWidth,
    binHeight,
  });
  const cached = await readPreviewCache(params.workspacePath, key);
  if (cached) return cached;

  const input: BuildEventPreviewInput = {
    samplePath,
    sampleId: params.sampleId,
    x: params.x,
    y: params.y,
    parent,
    maxEvents,
    format,
    binWidth,
    binHeight,
  };
  const preview = await runPreviewWorker(input);
  await writePreviewCache(params.workspacePath, key, preview);
  return preview;
}
