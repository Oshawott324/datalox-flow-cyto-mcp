import type { AxisScale, AxisTransformParams, CompensationMatrix } from "./types.js";

type XmlNode = Record<string, unknown>;

/** One FlowJo spillover matrix bound to exactly one loaded sample. */
export type ImportedFlowJoMatrix = {
  compensation: CompensationMatrix;
  /** FlowJo's own transforms:id, preserved so a panel reference can be traced. */
  flowjoId: string;
  /** The channel-name prefix this matrix declares, e.g. "Comp-". */
  prefix: string;
  flowjoName: string;
};

export type ImportedAxisTransform = {
  scale: AxisScale;
  params?: AxisTransformParams;
  /** The FlowJo transform element name, for diagnostics. */
  kind: string;
};

function asRecord(value: unknown): XmlNode | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as XmlNode : null;
}

function arrayOf(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function stringAttr(node: XmlNode | null, key: string): string | undefined {
  const value = node?.[key];
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
}

function numberAttr(node: XmlNode | null, key: string): number | undefined {
  const value = node?.[key];
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `<data-type:parameter data-type:name="X"/>` collapses to `parameter.name`. */
function parameterNameOf(node: XmlNode | null): string | undefined {
  return stringAttr(asRecord(node?.parameter), "name");
}

/**
 * Builds one CompensationMatrix from a FlowJo `<transforms:spilloverMatrix>`.
 *
 * FlowJo writes one `<transforms:spillover data-type:parameter="A">` per source
 * fluorochrome, holding one `<transforms:coefficient data-type:parameter="B">`
 * per destination detector. That is row = source fluorochrome, column =
 * destination detector, which is the convention CompensationMatrix.matrix already
 * documents, so values transfer without transposition.
 *
 * Channel names are resolved through the owning sample's FCS metadata, so the
 * stored matrix uses canonical parameter names like the rest of the workspace.
 */
export function importSpilloverMatrix(input: {
  node: XmlNode;
  sampleId: string;
  resolveChannel: (channel: string) => string;
  index: number;
}): { matrix: ImportedFlowJoMatrix } | { error: string } {
  const { node, sampleId, resolveChannel } = input;
  const flowjoName = stringAttr(node, "name") ?? "Compensation";
  const prefix = stringAttr(node, "prefix") ?? "";
  const flowjoId = stringAttr(node, "id") ?? `${sampleId}_${input.index}`;

  const declared = arrayOf(asRecord(node.parameters)?.parameter)
    .map(asRecord)
    .map((entry) => stringAttr(entry, "name"))
    .filter((name): name is string => Boolean(name));

  const rows = arrayOf(node.spillover).map(asRecord).filter((entry): entry is XmlNode => entry !== null);
  if (rows.length === 0) return { error: `Matrix "${flowjoName}" for sample ${sampleId} declares no spillover rows.` };

  const rowNames = rows.map((row) => stringAttr(row, "parameter")).filter((name): name is string => Boolean(name));
  if (rowNames.length !== rows.length) {
    return { error: `Matrix "${flowjoName}" for sample ${sampleId} has a spillover row with no parameter name.` };
  }
  // Column order follows the declared parameter list when present, so a row that
  // lists coefficients in a different order still lands in the right column.
  const order = declared.length > 0 ? declared : rowNames;
  if (order.length !== rows.length) {
    return {
      error: `Matrix "${flowjoName}" for sample ${sampleId} declares ${order.length} parameters but ${rows.length} spillover rows.`,
    };
  }

  const matrix: number[][] = [];
  for (const rowName of order) {
    const row = rows.find((entry) => stringAttr(entry, "parameter") === rowName);
    if (!row) return { error: `Matrix "${flowjoName}" for sample ${sampleId} has no spillover row for ${rowName}.` };
    const coefficients = new Map<string, number>();
    for (const entry of arrayOf(row.coefficient).map(asRecord)) {
      const name = stringAttr(entry, "parameter");
      const value = numberAttr(entry, "value");
      if (name && value !== undefined) coefficients.set(name, value);
    }
    const values = order.map((columnName) => coefficients.get(columnName));
    if (values.some((value) => value === undefined)) {
      const missing = order.filter((columnName) => !coefficients.has(columnName));
      return {
        error: `Matrix "${flowjoName}" for sample ${sampleId} row ${rowName} is missing coefficients for ${missing.join(", ")}.`,
      };
    }
    matrix.push(values as number[]);
  }

  const channels = order.map((name) => resolveChannel(name));
  if (new Set(channels).size !== channels.length) {
    return {
      error: `Matrix "${flowjoName}" for sample ${sampleId} resolves two parameters to the same channel (${channels.join(", ")}).`,
    };
  }

  return {
    matrix: {
      compensation: {
        // The sample is part of the id because FlowJo reuses one transforms:id
        // across every per-sample matrix in a workspace. Keying on the FlowJo id
        // alone collapses all of them into one entry, which would silently
        // compensate every panel with some other sample's matrix.
        id: `flowjo_${sampleId}_${flowjoId}`,
        name: `${flowjoName} (${sampleId})`,
        source: "flowjo_wsp",
        sample: sampleId,
        channels,
        matrix,
      },
      flowjoId,
      prefix,
      flowjoName,
    },
  };
}

const TRANSFORM_SCALES: Record<string, AxisScale> = {
  linear: "linear",
  log: "log",
  flog: "log",
  fasinh: "arcsinh",
  biex: "biex",
};

function transformParams(kind: string, node: XmlNode): AxisTransformParams | undefined {
  if (kind === "biex") {
    const params: AxisTransformParams = {
      maxRange: numberAttr(node, "maxRange"),
      pos: numberAttr(node, "pos"),
      neg: numberAttr(node, "neg"),
      width: numberAttr(node, "width"),
      length: numberAttr(node, "length"),
    };
    return Object.values(params).some((value) => value !== undefined) ? params : undefined;
  }
  if (kind === "fasinh") {
    const cofactor = numberAttr(node, "T") ?? numberAttr(node, "t") ?? numberAttr(node, "cofactor");
    return cofactor === undefined ? undefined : { cofactor };
  }
  return undefined;
}

/**
 * Parses one sample's own `<Transformations>` block, keyed by the raw FlowJo
 * parameter name. Keys are kept verbatim, including any compensation prefix,
 * because FlowJo defines separate transforms for "FL03-A" and "Comp-FL03-A" and
 * they are not required to agree. Looking a layout axis up by its stripped name,
 * or against a workspace-wide map, can therefore return the wrong transform.
 */
export function importSampleTransforms(sampleNode: XmlNode): Map<string, ImportedAxisTransform> {
  const transforms = new Map<string, ImportedAxisTransform>();
  const block = asRecord(sampleNode.Transformations);
  if (!block) return transforms;
  for (const [kind, scale] of Object.entries(TRANSFORM_SCALES)) {
    for (const entry of arrayOf(block[kind]).map(asRecord)) {
      if (!entry) continue;
      const name = parameterNameOf(entry);
      if (!name || transforms.has(name)) continue;
      const params = transformParams(kind, entry);
      transforms.set(name, { scale, kind, ...(params ? { params } : {}) });
    }
  }
  return transforms;
}
