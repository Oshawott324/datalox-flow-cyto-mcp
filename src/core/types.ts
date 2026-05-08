export type AxisScale = "linear" | "arcsinh" | "biex";

export type FlowcytoSample = {
  id: string;
  path: string;
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
  sampledEvents: number;
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
