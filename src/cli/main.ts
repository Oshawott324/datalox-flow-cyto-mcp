#!/usr/bin/env node
import { Command } from "commander";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { launchNativeGateEditorWindow, nativeGateEditorReadiness } from "../app/gate-editor/native-window.js";
import { startGateEditorServer } from "../app/gate-editor/server.js";
import {
  FlowcytoError,
  getEventPreview,
  getSampleMetadata,
  initWorkspace,
  openFcsArtifact,
  openWorkspace,
  readWorkspace,
  validateWorkspace,
  writeWorkspace,
  type FlowcytoWorkspace,
} from "../core/index.js";

const program = new Command();

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function handleError(error: unknown): never {
  if (error instanceof FlowcytoError) {
    printJson({
      ok: false,
      errors: [{ path: error.path ?? "/", code: error.code, message: error.message }],
    });
    process.exit(1);
  }
  const message = error instanceof Error ? error.message : String(error);
  printJson({
    ok: false,
    errors: [{ path: "/", code: "command_failed", message }],
  });
  process.exit(1);
}

program
  .name("flowcyto")
  .description("Flow cytometry workspace CLI for the Flowcyto MCP core.")
  .version("0.1.4");

program
  .command("open-fcs")
  .description("Open an .fcs file or flowcyto.workspace.json, creating or reusing a Flowcyto workspace.")
  .argument("<path>")
  .option("--workspace-dir <dir>", "Directory where flowcyto.workspace.json should be created or reused")
  .option("--sample-id <id>", "Sample id for a new FCS sample")
  .action(async (inputPath: string, options: { workspaceDir?: string; sampleId?: string }) => {
    try {
      const result = await openFcsArtifact({
        path: inputPath,
        workspaceDir: options.workspaceDir,
        sampleId: options.sampleId,
      });
      const view = result.recommendedViews[0];
      printJson({
        ...result,
        gateEditorPolicy: {
          compactGateEditorRequired: true,
          openCommand: "flowcyto open-gate-editor-window",
          requiredFor: ["gate", "draw", "edit", "inspect_population"],
          reason: "Open the compact gate editor before drawing or editing gates so user-visible state updates live.",
        },
        nextAction: {
          command: "flowcyto open-gate-editor-window",
          required: true,
          reason: "Open the compact gate editor before gate writes.",
          arguments: {
            workspace_path: result.workspacePath,
            sample_id: result.sampleId,
            x: view?.x ?? result.channels[0]?.name,
            y: view?.y ?? result.channels[1]?.name,
          },
        },
      });
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("init")
  .argument("<root-dir>")
  .requiredOption("--sample <path>", "FCS sample path")
  .option("--sample-id <id>", "Sample id")
  .option("--overwrite", "Overwrite an existing workspace")
  .action(async (rootDir: string, options: { sample: string; sampleId?: string; overwrite?: boolean }) => {
    try {
      const result = await initWorkspace({
        rootDir,
        samplePath: options.sample,
        sampleId: options.sampleId,
        overwrite: Boolean(options.overwrite),
      });
      printJson({ ok: true, ...result });
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("open")
  .argument("<workspace-path>")
  .action(async (workspacePath: string) => {
    try {
      printJson({ ok: true, summary: await openWorkspace(workspacePath) });
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("validate")
  .argument("<workspace-path>")
  .action(async (workspacePath: string) => {
    try {
      const result = await validateWorkspace(workspacePath);
      printJson(result);
      if (!result.ok) process.exit(1);
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("metadata")
  .argument("<workspace-path>")
  .requiredOption("--sample <id>", "Sample id")
  .action(async (workspacePath: string, options: { sample: string }) => {
    try {
      printJson({ ok: true, metadata: await getSampleMetadata(workspacePath, options.sample) });
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("preview")
  .argument("<workspace-path>")
  .requiredOption("--sample <id>", "Sample id")
  .requiredOption("--x <channel>", "X channel")
  .requiredOption("--y <channel>", "Y channel")
  .option("--parent <gate-id>", "Parent gate id", "root")
  .option("--max-events <n>", "Maximum preview events", (value) => Number.parseInt(value, 10), 10000)
  .option("--format <format>", "Preview format: auto, points, or bins", "auto")
  .action(async (
    workspacePath: string,
    options: { sample: string; x: string; y: string; parent: string; maxEvents: number; format: "auto" | "points" | "bins" },
  ) => {
    try {
      printJson({
        ok: true,
        preview: await getEventPreview({
          workspacePath,
          sampleId: options.sample,
          x: options.x,
          y: options.y,
          parent: options.parent,
          maxEvents: options.maxEvents,
          format: options.format,
        }),
      });
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("set-workspace")
  .argument("<workspace-path>")
  .requiredOption("--json <path>", "Path to replacement workspace JSON")
  .option("--expected-revision <n>", "Expected current revision", (value) => Number.parseInt(value, 10))
  .action(async (workspacePath: string, options: { json: string; expectedRevision?: number }) => {
    try {
      const { promises: fs } = await import("node:fs");
      const workspace = JSON.parse(await fs.readFile(options.json, "utf8")) as FlowcytoWorkspace;
      printJson(await writeWorkspace({ workspacePath, workspace, expectedRevision: options.expectedRevision }));
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("read-workspace")
  .argument("<workspace-path>")
  .action(async (workspacePath: string) => {
    try {
      printJson({ ok: true, workspace: await readWorkspace(workspacePath) });
    } catch (error) {
      handleError(error);
    }
  });

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

program
  .command("doctor")
  .description("Check the local Flowcyto CLI/MCP alpha installation.")
  .action(async () => {
    try {
      const cliPath = fileURLToPath(import.meta.url);
      const mcpPath = fileURLToPath(new URL("../mcp/server.js", import.meta.url));
      const nodeMajor = Number(process.versions.node.split(".")[0]);
      const nativePreview = nativeGateEditorReadiness();
      const checks = [
        {
          name: "node_runtime",
          ok: Number.isInteger(nodeMajor) && nodeMajor >= 20,
          detail: `node ${process.versions.node}`,
        },
        {
          name: "flowcyto_bin",
          ok: await pathExists(cliPath),
          detail: cliPath,
        },
        {
          name: "flowcyto_mcp_bin",
          ok: await pathExists(mcpPath),
          detail: mcpPath,
        },
        {
          name: "native_preview",
          ok: nativePreview.ok,
          detail: nativePreview.detail,
        },
      ];
      const ok = checks.every((check) => check.ok);
      printJson({
        ok,
        checks,
        commands: {
          cli: "flowcyto",
          mcp: "flowcyto-mcp",
          nativePreview: "flowcyto open-gate-editor-window <workspace-path>",
        },
      });
      if (!ok) process.exit(1);
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("open-gate-editor")
  .argument("<workspace-path>")
  .option("--host <host>", "Host for the local gate editor server", "127.0.0.1")
  .option("--port <n>", "Port for the local gate editor server", (value) => Number.parseInt(value, 10), 0)
  .option("--sample <id>", "Initial sample id")
  .option("--x <channel>", "Initial X channel")
  .option("--y <channel>", "Initial Y channel")
  .option("--max-events <n>", "Maximum preview events", (value) => Number.parseInt(value, 10), 10000)
  .action(async (
    workspacePath: string,
    options: { host: string; port: number; sample?: string; x?: string; y?: string; maxEvents: number },
  ) => {
    try {
      const server = await startGateEditorServer({
        workspacePath,
        host: options.host,
        port: options.port,
        sampleId: options.sample,
        x: options.x,
        y: options.y,
        maxEvents: options.maxEvents,
      });
      printJson({
        ok: true,
        sessionId: server.sessionId,
        workspacePath: server.workspacePath,
        host: server.host,
        port: server.port,
        url: server.url,
        mcpAppPreviewUrl: server.mcpAppPreviewUrl,
      });
      process.stderr.write(`flowcyto gate editor listening at ${server.url}\n`);
      await new Promise<void>(() => undefined);
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("open-gate-editor-window")
  .description("Open the gate editor in a compact native desktop window using the MCP app preview transport.")
  .argument("<workspace-path>")
  .option("--host <host>", "Host for the local gate editor server", "127.0.0.1")
  .option("--port <n>", "Port for the local gate editor server", (value) => Number.parseInt(value, 10), 0)
  .option("--sample <id>", "Initial sample id")
  .option("--x <channel>", "Initial X channel")
  .option("--y <channel>", "Initial Y channel")
  .option("--max-events <n>", "Maximum preview events", (value) => Number.parseInt(value, 10), 10000)
  .option("--width <px>", "Native window width", (value) => Number.parseInt(value, 10), 620)
  .option("--height <px>", "Native window height", (value) => Number.parseInt(value, 10), 620)
  .action(async (
    workspacePath: string,
    options: {
      host: string;
      port: number;
      sample?: string;
      x?: string;
      y?: string;
      maxEvents: number;
      width: number;
      height: number;
    },
  ) => {
    const server = await startGateEditorServer({
      workspacePath,
      host: options.host,
      port: options.port,
      sampleId: options.sample,
      x: options.x,
      y: options.y,
      maxEvents: options.maxEvents,
    }).catch((error) => {
      handleError(error);
    });
    try {
      const nativeWindow = launchNativeGateEditorWindow({
        url: server.mcpAppPreviewUrl,
        title: `${path.basename(workspacePath)} - Flowcyto`,
        width: options.width,
        height: options.height,
      });
      await nativeWindow.ready;
      printJson({
        ok: true,
        sessionId: server.sessionId,
        workspacePath: server.workspacePath,
        host: server.host,
        port: server.port,
        url: server.url,
        mcpAppPreviewUrl: server.mcpAppPreviewUrl,
        surface: {
          kind: "native_window",
          runtime: nativeWindow.runtime,
          pid: nativeWindow.pid,
          url: server.mcpAppPreviewUrl,
          preferredWidth: options.width,
          preferredHeight: options.height,
        },
      });
      process.stderr.write(`flowcyto gate editor native window listening at ${server.mcpAppPreviewUrl}\n`);
      await nativeWindow.wait();
      await server.close();
    } catch (error) {
      await server.close().catch(() => undefined);
      handleError(error);
    }
  });

program.parseAsync(process.argv).catch(handleError);
