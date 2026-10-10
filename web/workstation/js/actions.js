// Talking to the workstation service: loading the workspace, running changes,
// undo and redo, and fetching the events a plot draws.

import { store, emitChange } from "./model.js";
import { messageDialog } from "./ui.js";

/** Set by app.js so other modules can open windows without importing it. */
export const registry = { openGraph: null, openCompensation: null, openMatrixEditor: null };

let statusNode;
export function setStatus(text, isError = false) {
  statusNode ??= document.getElementById("statusbar");
  statusNode.textContent = text;
  statusNode.classList.toggle("error", isError);
}

async function getJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  const body = await response.json();
  if (!body.ok) throw new Error(body.error?.message ?? `Request failed: ${path}`);
  return body;
}

let loading = null;
export function refresh() {
  loading ??= (async () => {
    try {
      const state = await getJson("/api/state");
      Object.assign(store, {
        revision: state.revision,
        workspaceName: state.workspaceName,
        workspace: state.workspace,
        samples: state.samples,
        axisDefaults: state.axisDefaults,
      });
      const tree = await getJson("/api/tree");
      if (tree.revision === store.revision) store.tree = tree.samples;
      emitChange("refresh");
    } finally {
      loading = null;
    }
  })();
  return loading;
}

const undoStack = [];
const redoStack = [];

async function post(operation, via) {
  const response = await fetch("/api/op", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation, expectedRevision: store.revision, via }),
  });
  return { status: response.status, body: await response.json() };
}

/**
 * Run one change. `undo` is the operation that reverses it, or a function of the
 * result returning that operation. Returns the result detail, or null on failure.
 */
export async function runOp(operation, { via, label, undo, quiet } = {}) {
  let result = await post(operation, via);
  if (result.status === 409) {
    await refresh();
    result = await post(operation, via);
  }
  if (!result.body.ok) {
    const message = result.body.error?.message ?? "The change could not be saved.";
    setStatus(message, true);
    if (!quiet) await messageDialog({ title: "Flowcyto", message });
    await refresh();
    return null;
  }
  if (undo) {
    const reverse = typeof undo === "function" ? undo(result.body.detail) : undo;
    if (reverse) {
      undoStack.push({ label: label ?? operation.op, undo: reverse, redo: operation, via });
      redoStack.length = 0;
    }
  }
  if (label) setStatus(label);
  await refresh();
  return result.body.detail ?? {};
}

export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

export async function undo() {
  const entry = undoStack.pop();
  if (!entry) return;
  const result = await post(entry.undo, "undo");
  if (result.body.ok) {
    redoStack.push(entry);
    setStatus(`Undid: ${entry.label}`);
  } else {
    setStatus(result.body.error?.message ?? "Could not undo.", true);
  }
  await refresh();
}

export async function redo() {
  const entry = redoStack.pop();
  if (!entry) return;
  const result = await post(entry.redo, "redo");
  if (result.body.ok) {
    undoStack.push(entry);
    setStatus(`Redid: ${entry.label}`);
  } else {
    setStatus(result.body.error?.message ?? "Could not redo.", true);
  }
  await refresh();
}

const eventCache = new Map();

/** Every event of a population in the given channels, compensated as the sample is. */
export async function fetchEvents(sampleId, populationId, channels) {
  const key = [store.revision, sampleId, populationId, ...channels].join("\u0000");
  if (!eventCache.has(key)) {
    const params = new URLSearchParams({ sample: sampleId, population: populationId, channels: channels.join(",") });
    eventCache.set(key, getJson(`/api/events?${params}`).then((body) => ({
      count: body.count,
      totalEvents: body.totalEvents,
      columns: body.columns.map((encoded) => {
        const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
        return new Float64Array(bytes.buffer);
      }),
    })));
    if (eventCache.size > 24) eventCache.delete(eventCache.keys().next().value);
  }
  try {
    return await eventCache.get(key);
  } catch (error) {
    eventCache.delete(key);
    throw error;
  }
}

export async function calculateCompensation(controls) {
  const response = await fetch("/api/compensation/calculate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ controls }),
  });
  return response.json();
}
