import { readFileSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";

import type { FlowcytoWorkspace } from "./types.js";
import { readWorkspace } from "./workspace.js";

export type WorkspaceFileChange = {
  workspacePath: string;
  revision: number;
  workspace: FlowcytoWorkspace;
};

export type WorkspaceFileError = {
  workspacePath: string;
  error: unknown;
};

export type WorkspaceWatcher = {
  close(): void;
};

export function watchWorkspaceFile(
  workspacePath: string,
  onChange: (change: WorkspaceFileChange) => void | Promise<void>,
  onError?: (error: WorkspaceFileError) => void | Promise<void>,
): WorkspaceWatcher {
  const target = path.resolve(workspacePath);
  const dir = path.dirname(target);
  const basename = path.basename(target);
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let watcher: FSWatcher;
  let lastRevision: number | undefined;

  async function emitIfChanged(): Promise<void> {
    if (closed) return;
    try {
      const workspace = await readWorkspace(target);
      if (workspace.revision === lastRevision) return;
      lastRevision = workspace.revision;
      await onChange({ workspacePath: target, revision: workspace.revision, workspace });
    } catch (error) {
      await onError?.({ workspacePath: target, error });
    }
  }

  function schedule(): void {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      emitIfChanged().catch((error) => onError?.({ workspacePath: target, error }));
    }, 40);
  }

  try {
    const workspace = JSON.parse(readFileSync(target, "utf8")) as FlowcytoWorkspace;
    lastRevision = workspace.revision;
  } catch {
    lastRevision = undefined;
  }

  watcher = watch(dir, (eventType, filename) => {
    if (eventType !== "change" && eventType !== "rename") return;
    if (!filename || filename.toString() === basename) schedule();
  });

  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}
