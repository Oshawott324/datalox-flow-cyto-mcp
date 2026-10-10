import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FlowcytoError,
  estimateCompensationFromGatedControls,
  getPopulationGraph,
  readFcsColumns,
  readFcsMetadata,
  readPopulationEvents,
  readWorkspace,
  resolveSamplePath,
  writeWorkspace,
  type AxisSetting,
  type FlowcytoWorkspace,
  type PopulationGraphNode,
  type SampleMetadata,
} from "../../core/index.js";
import { Journal } from "./journal.js";
import { applyOperation, type WorkstationOperation } from "./operations.js";

/**
 * Flowcyto Workstation: a FlowJo-style desktop for one workspace, served to a
 * browser. The page is the only client. Every change goes through POST /api/op,
 * is written as one workspace revision and is recorded in the journal.
 */
export type WorkstationOptions = {
  workspacePath: string;
  host?: string;
  port?: number;
  /** Directory holding index.html and the scripts. Defaults to the packaged web/workstation. */
  webRoot?: string;
};

export type WorkstationServer = {
  url: string;
  host: string;
  port: number;
  close(): Promise<void>;
};

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
// web/workstation sits at the package root: three levels up from src/, four from dist/src/.
const DEFAULT_WEB_ROOT = ["../../../web/workstation", "../../../../web/workstation"]
  .map((relative) => path.resolve(MODULE_DIR, relative))
  .find((candidate) => existsSync(path.join(candidate, "index.html"))) ?? path.resolve(MODULE_DIR, "../../../../web/workstation");
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

type SampleInfo = {
  id: string;
  name: string;
  eventCount: number;
  parameters: Array<{ name: string; detector?: string; marker?: string }>;
};

type TreeCounts = Record<string, { total: number; populations: Record<string, { count: number; parentCount: number }> }>;

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function errorBody(error: unknown) {
  if (error instanceof FlowcytoError) return { ok: false, error: { code: error.code, message: error.message, path: error.path ?? "/" } };
  return { ok: false, error: { code: "request_failed", message: error instanceof Error ? error.message : String(error), path: "/" } };
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).byteLength;
    if (size > 4_000_000) throw new FlowcytoError("request_too_large", "Request body exceeds 4 MB.");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

function isScatter(parameter: { name: string; detector?: string }): boolean {
  return /^(fsc|ssc|fs\d|ss\d)/i.test(parameter.name) || /^(fsc|ssc|fs\d|ss\d)/i.test(parameter.detector ?? "");
}

function isFluorescence(parameter: { name: string; detector?: string }): boolean {
  return !isScatter(parameter) && /-(a|h)$/i.test(parameter.name) && !/time/i.test(parameter.name);
}

function quantile(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low);
}

function niceCeil(value: number): number {
  if (!(value > 0)) return 1;
  const exponent = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (step * exponent >= value) return step * exponent;
  return 10 * exponent;
}

export async function startWorkstation(options: WorkstationOptions): Promise<WorkstationServer> {
  const workspacePath = path.resolve(options.workspacePath);
  const webRoot = options.webRoot ?? DEFAULT_WEB_ROOT;
  const initial = await readWorkspace(workspacePath);
  const journal = await Journal.open(workspacePath, initial.revision);

  const metadataCache = new Map<string, Promise<SampleMetadata>>();
  const metadata = (workspace: FlowcytoWorkspace, sampleId: string): Promise<SampleMetadata> => {
    const sample = workspace.samples.find((entry) => entry.id === sampleId);
    if (!sample) throw new FlowcytoError("unknown_sample", `Sample ${sampleId} is not present.`);
    const key = `${sample.id}\u0000${sample.path}`;
    if (!metadataCache.has(key)) metadataCache.set(key, readFcsMetadata(resolveSamplePath(workspacePath, sample.path), sample.id));
    return metadataCache.get(key)!;
  };

  const sampleInfo = async (workspace: FlowcytoWorkspace): Promise<SampleInfo[]> => Promise.all(workspace.samples.map(async (sample) => {
    const meta = await metadata(workspace, sample.id);
    return {
      id: sample.id,
      name: path.basename(sample.path),
      eventCount: meta.eventCount ?? 0,
      parameters: meta.parameters.map((parameter) => ({ name: parameter.name, detector: parameter.detector, marker: parameter.marker })),
    };
  }));

  // Default axes, worked out once from every sample's raw events, as FlowJo does from the
  // parameter ranges: linear for scatter and time, biex for fluorescence.
  let axisDefaults: Promise<Record<string, AxisSetting>> | undefined;
  const computeAxisDefaults = async (workspace: FlowcytoWorkspace): Promise<Record<string, AxisSetting>> => {
    const values = new Map<string, number[]>();
    const kinds = new Map<string, { name: string; detector?: string; range?: number | null }>();
    for (const sample of workspace.samples) {
      const meta = await metadata(workspace, sample.id);
      const names = meta.parameters.map((parameter) => parameter.name);
      meta.parameters.forEach((parameter) => kinds.set(parameter.name, parameter));
      const columns = await readFcsColumns({ path: resolveSamplePath(workspacePath, sample.path), channels: names });
      const stride = Math.max(1, Math.floor(columns.values.length / 20_000));
      for (let row = 0; row < columns.values.length; row += stride) {
        names.forEach((name, index) => {
          const list = values.get(name) ?? [];
          list.push(columns.values[row]![index]!);
          values.set(name, list);
        });
      }
    }
    const out: Record<string, AxisSetting> = {};
    for (const [name, list] of values) {
      const sorted = Float64Array.from(list.filter(Number.isFinite)).sort();
      const parameter = kinds.get(name)!;
      const top = quantile(sorted, 0.9995);
      const low = quantile(sorted, 0.0005);
      if (isFluorescence(parameter)) {
        const max = niceCeil(Math.max(top * 1.5, 10));
        const negativeSpread = low < 0 ? -low : 0;
        const width = niceCeil(Math.max(negativeSpread, quantile(sorted, 0.1) / 4, max / 10 ** 4.5));
        out[name] = { scale: "biex", min: -10 * width, max, width };
      } else {
        // Linear axes run to the parameter's range ($PnR), as in FlowJo, unless the data go past it.
        const range = Number(parameter.range);
        const max = Number.isFinite(range) && range > 0 && top <= range * 1.0001 ? range : niceCeil(Math.max(top * 1.1, 1));
        out[name] = { scale: "linear", min: low < 0 ? -niceCeil(-low * 1.1) : 0, max };
      }
    }
    return out;
  };

  const treeCache = new Map<number, Promise<TreeCounts>>();
  const tree = (workspace: FlowcytoWorkspace): Promise<TreeCounts> => {
    if (!treeCache.has(workspace.revision)) {
      treeCache.clear();
      treeCache.set(workspace.revision, (async () => {
        const out: TreeCounts = {};
        await Promise.all(workspace.samples.map(async (sample) => {
          const graph = await getPopulationGraph({ workspacePath, sampleId: sample.id, compensationId: workspace.sampleCompensation?.[sample.id] });
          const populations: TreeCounts[string]["populations"] = {};
          const walk = (node: PopulationGraphNode, parentCount: number) => {
            if (node.gateId !== "root") populations[node.gateId] = { count: node.count, parentCount };
            node.children.forEach((child) => walk(child, node.count));
          };
          walk(graph.root, graph.root.count);
          out[sample.id] = { total: graph.root.count, populations };
        }));
        return out;
      })());
    }
    return treeCache.get(workspace.revision)!;
  };

  // One write at a time, so revisions and journal lines stay in step.
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  const runOperation = (body: Record<string, unknown>) => serialize(async () => {
    const operation = body.operation as WorkstationOperation | undefined;
    if (!operation || typeof operation.op !== "string") throw new FlowcytoError("missing_operation", "operation is required.", "/operation");
    const workspace = await readWorkspace(workspacePath);
    if (body.expectedRevision !== workspace.revision) {
      return { status: 409, body: { ok: false, revision: workspace.revision, error: { code: "stale_revision", message: "The workspace changed. Reload and try again.", path: "/revision" } } };
    }
    const { workspace: next, detail } = applyOperation(workspace, operation);
    const write = await writeWorkspace({ workspacePath, workspace: next, expectedRevision: workspace.revision });
    if (!write.ok) {
      const first = write.errors[0];
      return { status: 422, body: { ok: false, revision: workspace.revision, error: { code: first?.code ?? "invalid_change", message: write.errors.map((error) => error.message).join(" "), path: first?.path ?? "/" } } };
    }
    const via = typeof body.via === "string" ? body.via.slice(0, 64) : undefined;
    const journalDetail: Record<string, unknown> = { ...detail, ...(via ? { via } : {}) };
    if (operation.op === "gate.save") journalDetail.gate = operation.gate;
    if (Array.isArray(journalDetail.removed)) journalDetail.removed = (journalDetail.removed as Array<{ id: string }>).map((gate) => gate.id);
    await journal.record(operation.op, write.revision!, journalDetail);
    return { status: 200, body: { ok: true, revision: write.revision, detail } };
  });

  const events = async (url: URL) => {
    const workspace = await readWorkspace(workspacePath);
    const sampleId = url.searchParams.get("sample") ?? "";
    const population = url.searchParams.get("population") || "root";
    const channels = (url.searchParams.get("channels") ?? "").split(",").filter(Boolean);
    const compensationId = workspace.sampleCompensation?.[sampleId];
    const result = await readPopulationEvents({ workspacePath, sampleId, channels, parent: population, compensationId });
    const columns = result.channels.map((_, index) => {
      const column = new Float64Array(result.rows.length);
      result.rows.forEach((row, rowIndex) => { column[rowIndex] = row[index]!; });
      return Buffer.from(column.buffer).toString("base64");
    });
    return {
      ok: true,
      revision: result.revision,
      sampleId,
      population,
      channels: result.channels,
      count: result.rows.length,
      totalEvents: result.totalEvents,
      compensationId: compensationId ?? null,
      columns,
    };
  };

  const handle = async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (request.method === "GET" && url.pathname === "/api/state") {
      const workspace = await readWorkspace(workspacePath);
      axisDefaults ??= computeAxisDefaults(workspace);
      send(response, 200, {
        ok: true,
        workspaceName: path.basename(workspacePath),
        revision: workspace.revision,
        workspace,
        samples: await sampleInfo(workspace),
        axisDefaults: await axisDefaults,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/tree") {
      const workspace = await readWorkspace(workspacePath);
      send(response, 200, { ok: true, revision: workspace.revision, samples: await tree(workspace) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      send(response, 200, await events(url));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/op") {
      const result = await runOperation(await readBody(request));
      send(response, result.status, result.body);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/compensation/calculate") {
      const body = await readBody(request);
      const controls = Array.isArray(body.controls) ? body.controls as Array<Record<string, string>> : [];
      const result = await estimateCompensationFromGatedControls({
        workspacePath,
        controls: controls.map((control) => ({
          sampleId: control.sampleId!,
          channel: control.channel!,
          positiveGateId: control.positiveGateId!,
          negativeGateId: control.negativeGateId!,
          ...(control.negativeSampleId ? { negativeSampleId: control.negativeSampleId } : {}),
        })),
      });
      send(response, 200, { ok: true, compensation: result.compensation, diagnostics: result.diagnostics });
      return;
    }
    if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
      const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
      const file = path.resolve(webRoot, relative);
      if (!file.startsWith(path.resolve(webRoot) + path.sep)) {
        send(response, 404, { ok: false });
        return;
      }
      const content = await fs.readFile(file).catch(() => null);
      if (!content) {
        send(response, 404, { ok: false, error: { code: "not_found", message: url.pathname } });
        return;
      }
      response.writeHead(200, { "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
      response.end(content);
      return;
    }
    send(response, 404, { ok: false, error: { code: "not_found", message: `No route for ${request.method} ${url.pathname}.` } });
  };

  const host = options.host ?? "127.0.0.1";
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
    handle(request, response, url).catch((error) => send(response, error instanceof FlowcytoError ? 400 : 500, errorBody(error)));
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("Workstation did not get a TCP port."));
      else resolve(address.port);
    });
  });
  return {
    url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}/`,
    host,
    port,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
