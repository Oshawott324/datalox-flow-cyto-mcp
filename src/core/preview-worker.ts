import { parentPort } from "node:worker_threads";

import { buildEventPreview, type BuildEventPreviewInput } from "./preview-build.js";
import { FlowcytoError } from "./types.js";

type WorkerRequest = {
  id: string;
  input: BuildEventPreviewInput;
};

function serializeError(error: unknown): { code: string; message: string; path?: string } {
  if (error instanceof FlowcytoError) {
    return { code: error.code, message: error.message, path: error.path };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "preview_worker_failed", message, path: "/" };
}

if (!parentPort) {
  throw new FlowcytoError("preview_worker_port_missing", "Preview worker started without a parent port.");
}

parentPort.on("message", async (request: WorkerRequest) => {
  try {
    parentPort?.postMessage({
      id: request.id,
      ok: true,
      preview: await buildEventPreview(request.input),
    });
  } catch (error) {
    parentPort?.postMessage({
      id: request.id,
      ok: false,
      error: serializeError(error),
    });
  }
});
