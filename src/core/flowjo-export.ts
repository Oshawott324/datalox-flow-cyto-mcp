import { promises as fs } from "node:fs";
import path from "node:path";

import { XMLBuilder } from "fast-xml-parser";

import { readWorkspace, resolveSamplePath, validateWorkspace } from "./workspace.js";
import { FlowcytoError, type FlowcytoSample, type FlowcytoWorkspace, type WorkspaceGate } from "./types.js";

export type ExportFlowJoWorkspaceInput = {
  workspacePath: string;
  outputPath: string;
  bundleMode?: "reference_only";
  compensationId?: string;
};

export type ExportFlowJoWorkspaceResult = {
  ok: true;
  wspPath: string;
  bundlePath: null;
  samplesExported: number;
  gatesExported: number;
  compensationExported: boolean;
  warnings: string[];
};

type XmlElement = Record<string, unknown>;

function sampleName(sample: FlowcytoSample): string {
  return path.basename(sample.path) || sample.id;
}

function fileUri(filePath: string): string {
  const normalized = path.resolve(filePath).replaceAll("\\", "/");
  if (/^[A-Za-z]:\//.test(normalized)) return `file:///${encodeURI(normalized).replaceAll("%2F", "/")}`;
  return `file://${encodeURI(normalized).replaceAll("%2F", "/")}`;
}

function gateName(gate: WorkspaceGate): string {
  return gate.name || gate.id;
}

function dimension(parameterName: string, min?: number, max?: number): XmlElement {
  return {
    "@_gating:compensation-ref": "uncompensated",
    ...(min !== undefined ? { "@_gating:min": String(min) } : {}),
    ...(max !== undefined ? { "@_gating:max": String(max) } : {}),
    "data-type:parameter": { "@_data-type:name": parameterName },
  };
}

function gateBody(gate: WorkspaceGate): XmlElement {
  if (gate.type === "polygon") {
    return {
      "gating:PolygonGate": {
        "@_gating:id": gate.id,
        "@_gating:parent_id": gate.parent === "root" ? "" : gate.parent,
        "gating:dimension": [dimension(gate.x), dimension(gate.y)],
        "gating:vertex": gate.vertices.map((vertex) => ({
          "gating:coordinate": [
            { "@_data-type:value": String(vertex[0]) },
            { "@_data-type:value": String(vertex[1]) },
          ],
        })),
      },
    };
  }
  if (gate.type === "rect") {
    return {
      "gating:RectangleGate": {
        "@_gating:id": gate.id,
        "@_gating:parent_id": gate.parent === "root" ? "" : gate.parent,
        "gating:dimension": [
          dimension(gate.x, gate.xMin, gate.xMax),
          dimension(gate.y, gate.yMin, gate.yMax),
        ],
      },
    };
  }
  return {
    "gating:RangeGate": {
      "@_gating:id": gate.id,
      "@_gating:parent_id": gate.parent === "root" ? "" : gate.parent,
      "gating:dimension": dimension(gate.x, gate.min, gate.max),
    },
  };
}

function buildGateTree(gates: WorkspaceGate[], parent: string): XmlElement[] {
  return gates
    .filter((gate) => gate.parent === parent)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((gate) => ({
      "@_name": gateName(gate),
      "@_owningGroup": "",
      "@_gating:id": gate.id,
      "@_gating:parent_id": gate.parent === "root" ? "" : gate.parent,
      ...gateBody(gate),
      Subpopulations: {
        Gate: buildGateTree(gates, gate.id),
      },
    }));
}

function sampleElement(workspacePath: string, workspace: FlowcytoWorkspace, sample: FlowcytoSample): XmlElement {
  const gates = workspace.gates.filter((gate) => gate.sample === sample.id);
  const rootGates = buildGateTree(gates, "root");
  return {
    DataSet: {
      "@_uri": fileUri(resolveSamplePath(workspacePath, sample.path)),
      "@_keyword": "$CYT",
    },
    SampleNode: {
      "@_name": sampleName(sample),
      "@_owningGroup": "",
      Subpopulations: {
        Gate: rootGates,
      },
    },
  };
}

function buildFlowJoXml(workspacePath: string, workspace: FlowcytoWorkspace): string {
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    format: true,
    suppressEmptyNode: true,
  });
  const document = {
    "?xml": { "@_version": "1.0", "@_encoding": "UTF-8" },
    Workspace: {
      "@_version": "20.0",
      "@_creator": "Flowcyto",
      "@_xmlns:gating": "http://www.isac-net.org/std/Gating-ML/v2.0/gating",
      "@_xmlns:data-type": "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes",
      "@_xmlns:transforms": "http://www.isac-net.org/std/Gating-ML/v2.0/transformations",
      SampleList: {
        Sample: workspace.samples.map((sample) => sampleElement(workspacePath, workspace, sample)),
      },
    },
  };
  return `${builder.build(document)}\n`;
}

export async function exportFlowJoWorkspace(input: ExportFlowJoWorkspaceInput): Promise<ExportFlowJoWorkspaceResult> {
  if (input.bundleMode && input.bundleMode !== "reference_only") {
    throw new FlowcytoError("unsupported_flowjo_bundle_mode", "Only reference_only FlowJo export is implemented.", "/bundle_mode");
  }
  const workspacePath = path.resolve(input.workspacePath);
  const outputPath = path.resolve(input.outputPath);
  const validation = await validateWorkspace(workspacePath);
  if (!validation.ok) {
    const first = validation.errors[0];
    throw new FlowcytoError(first?.code ?? "invalid_workspace", first?.message ?? "Workspace is invalid.", first?.path);
  }
  const workspace = await readWorkspace(workspacePath);
  if (input.compensationId && !workspace.compensations?.some((matrix) => matrix.id === input.compensationId)) {
    throw new FlowcytoError("unknown_compensation", `Compensation ${input.compensationId} is not present.`, "/compensation_id");
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, buildFlowJoXml(workspacePath, workspace), "utf8");
  return {
    ok: true,
    wspPath: outputPath,
    bundlePath: null,
    samplesExported: workspace.samples.length,
    gatesExported: workspace.gates.length,
    compensationExported: false,
    warnings: input.compensationId ? ["Compensation matrix export is not implemented in this initial FlowJo export path."] : [],
  };
}
