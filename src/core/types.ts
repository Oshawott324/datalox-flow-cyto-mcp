export type AxisScale = "linear" | "log" | "arcsinh" | "biex";

export type FlowcytoSample = {
  id: string;
  path: string;
};

export type CompensationKeyword = "$SPILLOVER" | "SPILLOVER" | "$COMP" | "COMP" | "$SPILL" | "SPILL";

export type CompensationMatrix = {
  id: string;
  name?: string;
  source: "fcs_keyword" | "manual";
  sample?: string;
  keyword?: CompensationKeyword;
  channels: string[];
  // matrix[i][j] = fraction of fluorochrome j spilling into detector i.
  // Apply as Xcomp = Xraw * inv(S), implemented as solve(S.T, Xraw.T).T.
  matrix: number[][];
};

export type CompensationStatus = {
  detectedAsPreCompensated: boolean;
  signals: string[];
  embeddedMatrixFound: boolean;
  suggestedCompensationId?: string;
  recommendation: string;
};

export type CompensationDiagnostics = {
  keywordsScanned: CompensationKeyword[];
  keywordsFound: string[];
  unparsedKeywordCandidates: string[];
  availableChannels: string[];
  matrixChannels?: string[];
  alignmentWarnings?: string[];
};

export type AppliedCompensation = {
  applied: boolean;
  id?: string;
  source?: CompensationMatrix["source"];
  channels?: string[];
  warnings?: string[];
};

export type FlowcytoView = {
  id: string;
  sample: string;
  parent: string;
  x: string;
  y: string;
  scale: {
    x: AxisScale;
    y: AxisScale;
  };
};

export type GateBase = {
  id: string;
  name?: string;
  sample: string;
  parent: string;
  enabled?: boolean;
};

export type PolygonGate = GateBase & {
  type: "polygon";
  x: string;
  y: string;
  vertices: Array<[number, number]>;
};

export type RectGate = GateBase & {
  type: "rect";
  x: string;
  y: string;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
};

export type RangeGate = GateBase & {
  type: "range";
  x: string;
  min: number;
  max: number;
};

export type WorkspaceGate = PolygonGate | RectGate | RangeGate;

export type FlowcytoWorkspace = {
  version: 1;
  revision: number;
  samples: FlowcytoSample[];
  views: FlowcytoView[];
  gates: WorkspaceGate[];
  compensations?: CompensationMatrix[];
  compensationStatus?: Record<string, CompensationStatus>;
};

export type ValidationError = {
  path: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type ValidationResult = {
  ok: boolean;
  errors: ValidationError[];
};

export type WorkspaceSummary = {
  workspacePath: string;
  rootDir: string;
  sampleCount: number;
  gateCount: number;
  viewCount: number;
  samples: FlowcytoSample[];
};

export type SampleParameter = {
  name: string;
  index: number;
  detector?: string;
  marker?: string;
  range?: number;
};

export type SampleMetadata = {
  sampleId: string;
  path: string;
  eventCount: number | null;
  parameters: SampleParameter[];
  keywords: Record<string, string>;
};

export type PreviewColumns = {
  x: Float32Array | Float64Array;
  y: Float32Array | Float64Array;
  totalEvents: number;
  filteredEvents: number;
  compensation?: AppliedCompensation;
};

export type PreviewFormat = "auto" | "points" | "bins";

export type EventPreview = {
  sampleId: string;
  x: string;
  y: string;
  parent: string;
  format: "points" | "bins";
  scale: { x: AxisScale; y: AxisScale };
  totalEvents: number;
  filteredEvents: number;
  sampledEvents: number;
  compensation?: AppliedCompensation;
  points?: Array<[number, number]>;
  bins?: {
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
    width: number;
    height: number;
    counts: number[];
  };
};

export class FlowcytoError extends Error {
  readonly code: string;
  readonly path?: string;

  constructor(code: string, message: string, path?: string) {
    super(message);
    this.name = "FlowcytoError";
    this.code = code;
    this.path = path;
  }
}
