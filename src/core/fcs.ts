import { promises as fs } from "node:fs";

import { FlowcytoError, type PreviewColumns, type SampleMetadata, type SampleParameter } from "./types.js";

type TextDict = Record<string, string>;

type FcsHeader = {
  version: string;
  textStart: number;
  textEnd: number;
  dataStart: number;
  dataEnd: number;
};

type ParsedHeaderText = {
  header: FcsHeader;
  text: TextDict;
};

const HEADER_SIZE = 58;

function readAsciiNumber(input: string): number {
  const trimmed = input.trim();
  if (!trimmed) return 0;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readHeader(buffer: Buffer, base = 0): FcsHeader {
  if (buffer.byteLength < base + HEADER_SIZE) {
    throw new FlowcytoError("invalid_fcs_header", "FCS file is too small to contain a 58-byte header.");
  }
  const header = buffer.subarray(base, base + HEADER_SIZE).toString("ascii");
  return {
    version: header.slice(0, 6).trim(),
    textStart: readAsciiNumber(header.slice(10, 18)),
    textEnd: readAsciiNumber(header.slice(18, 26)),
    dataStart: readAsciiNumber(header.slice(26, 34)),
    dataEnd: readAsciiNumber(header.slice(34, 42)),
  };
}

function decodeText(bytes: Buffer): string {
  return bytes.toString("latin1");
}

function parseTextSegment(bytes: Buffer): TextDict {
  if (bytes.length === 0) return {};
  const raw = decodeText(bytes);
  const delim = raw[0];
  const parts: string[] = [];
  let cur = "";
  let i = 1;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === delim) {
      if (i + 1 < raw.length && raw[i + 1] === delim) {
        cur += delim;
        i += 2;
        continue;
      }
      parts.push(cur);
      cur = "";
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }

  const dict: TextDict = {};
  for (let j = 0; j + 1 < parts.length; j += 2) {
    dict[parts[j]] = parts[j + 1];
  }
  return dict;
}

async function readHeaderText(path: string, dataSet = 0): Promise<ParsedHeaderText> {
  const handle = await fs.open(path, "r");
  try {
    let base = 0;
    let index = 0;
    while (true) {
      const headerBuffer = Buffer.alloc(HEADER_SIZE);
      await handle.read(headerBuffer, 0, HEADER_SIZE, base);
      const header = readHeader(headerBuffer);
      if (header.textEnd < header.textStart || header.textStart <= 0) {
        throw new FlowcytoError("invalid_fcs_text_segment", `Invalid FCS TEXT segment bounds in ${path}.`);
      }
      const textLength = header.textEnd - header.textStart + 1;
      const textBuffer = Buffer.alloc(textLength);
      await handle.read(textBuffer, 0, textLength, base + header.textStart);
      const text = parseTextSegment(textBuffer);
      if (index === dataSet) {
        return {
          header: {
            ...header,
            textStart: base + header.textStart,
            textEnd: base + header.textEnd,
            dataStart: base + header.dataStart,
            dataEnd: base + header.dataEnd,
          },
          text,
        };
      }
      const next = Number(text.$NEXTDATA || text.NEXTDATA || 0);
      if (!next || next <= 0) {
        return {
          header: {
            ...header,
            textStart: base + header.textStart,
            textEnd: base + header.textEnd,
            dataStart: base + header.dataStart,
            dataEnd: base + header.dataEnd,
          },
          text,
        };
      }
      base = next;
      index += 1;
    }
  } finally {
    await handle.close();
  }
}

function getParamNamesAuto(text: TextDict, parameterCount: number): { names: string[]; source: "$PnS" | "$PnN" } {
  const pns: string[] = [];
  const pnn: string[] = [];
  for (let i = 1; i <= parameterCount; i += 1) {
    pns.push((text[`$P${i}S`] ?? "").trim());
    pnn.push((text[`$P${i}N`] ?? "").trim());
  }
  const sComplete = pns.every((value) => value.length > 0);
  const nComplete = pnn.every((value) => value.length > 0);
  const sUnique = new Set(pns).size === pns.length;
  const nUnique = new Set(pnn).size === pnn.length;
  if (sComplete && (!nComplete || (sUnique && !nUnique))) return { names: pns, source: "$PnS" };
  if (nComplete && (!sComplete || (nUnique && !sUnique))) return { names: pnn, source: "$PnN" };
  if (sComplete) return { names: pns, source: "$PnS" };
  if (nComplete) return { names: pnn, source: "$PnN" };
  return { names: Array.from({ length: parameterCount }, (_, index) => `P${index + 1}`), source: "$PnS" };
}

function parseParameterMetadata(text: TextDict, parameterCount: number): SampleParameter[] {
  const { names } = getParamNamesAuto(text, parameterCount);
  return names.map((name, index) => {
    const parameterIndex = index + 1;
    const detector = (text[`$P${parameterIndex}N`] ?? "").trim() || undefined;
    const marker = (text[`$P${parameterIndex}S`] ?? "").trim() || undefined;
    const rangeRaw = Number(text[`$P${parameterIndex}R`]);
    return {
      name,
      index,
      detector,
      marker,
      range: Number.isFinite(rangeRaw) ? rangeRaw : undefined,
    };
  });
}

function byteOrderIsLittleEndian(byteOrder: string): boolean {
  const normalized = byteOrder.replace(/\s+/g, "");
  if (normalized === "1,2,3,4" || normalized === "1234") return true;
  if (normalized === "4,3,2,1" || normalized === "4321") return false;
  return true;
}

function readUint24(view: DataView, offset: number, littleEndian: boolean): number {
  if (littleEndian) {
    return view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
  }
  return (view.getUint8(offset) << 16) | (view.getUint8(offset + 1) << 8) | view.getUint8(offset + 2);
}

function rowByteLayout(text: TextDict, parameterCount: number, dtype: string): number[] {
  if (dtype === "F") return Array.from({ length: parameterCount }, () => 4);
  if (dtype === "D") return Array.from({ length: parameterCount }, () => 8);
  if (dtype !== "I") {
    throw new FlowcytoError("unsupported_fcs_datatype", `Unsupported $DATATYPE ${dtype}.`);
  }
  return Array.from({ length: parameterCount }, (_, index) => {
    const bits = Number(text[`$P${index + 1}B`] || 16);
    if (bits === 8) return 1;
    if (bits === 16) return 2;
    if (bits === 24) return 3;
    if (bits === 32) return 4;
    throw new FlowcytoError("unsupported_integer_bit_width", `Unsupported integer bit width ${bits}.`);
  });
}

function readValue(params: {
  view: DataView;
  offset: number;
  dtype: string;
  bytes: number;
  littleEndian: boolean;
}): number {
  const { view, offset, dtype, bytes, littleEndian } = params;
  if (dtype === "F") return view.getFloat32(offset, littleEndian);
  if (dtype === "D") return view.getFloat64(offset, littleEndian);
  if (bytes === 1) return view.getUint8(offset);
  if (bytes === 2) return view.getUint16(offset, littleEndian);
  if (bytes === 3) return readUint24(view, offset, littleEndian);
  if (bytes === 4) return view.getUint32(offset, littleEndian);
  throw new FlowcytoError("unsupported_value_width", `Unsupported value width ${bytes}.`);
}

function dataBounds(header: FcsHeader, text: TextDict): { begin: number; end: number } {
  const begin = Number(text.$BEGINDATA) || header.dataStart;
  const end = Number(text.$ENDDATA) || header.dataEnd;
  if (!Number.isFinite(begin) || !Number.isFinite(end) || end < begin) {
    throw new FlowcytoError("invalid_fcs_data_segment", "Invalid FCS DATA segment bounds.");
  }
  return { begin, end };
}

export async function readFcsMetadata(path: string, sampleId = ""): Promise<SampleMetadata> {
  const { text } = await readHeaderText(path);
  const parameterCount = Number(text.$PAR) || 0;
  if (!parameterCount) {
    throw new FlowcytoError("invalid_fcs_parameters", `Invalid FCS file ${path}: missing $PAR.`);
  }
  const eventCount = Number(text.$TOT);
  return {
    sampleId,
    path,
    eventCount: Number.isFinite(eventCount) ? eventCount : null,
    parameters: parseParameterMetadata(text, parameterCount),
    keywords: text,
  };
}

export async function readPreviewColumns(input: {
  path: string;
  x: string;
  y: string;
  maxEvents?: number;
}): Promise<PreviewColumns> {
  const { path, x, y, maxEvents } = input;
  const { header, text } = await readHeaderText(path);
  const parameterCount = Number(text.$PAR) || 0;
  const totalEvents = Number(text.$TOT) || 0;
  if (!parameterCount || !totalEvents) {
    throw new FlowcytoError("invalid_fcs_parameters", `Invalid FCS file ${path}: missing $PAR or $TOT.`);
  }
  const parameters = parseParameterMetadata(text, parameterCount);
  const xIndex = parameters.findIndex((parameter) => parameter.name === x);
  const yIndex = parameters.findIndex((parameter) => parameter.name === y);
  if (xIndex === -1) throw new FlowcytoError("unknown_parameter", `Parameter ${x} is not present.`, "/x");
  if (yIndex === -1) throw new FlowcytoError("unknown_parameter", `Parameter ${y} is not present.`, "/y");

  const dtype = (text.$DATATYPE || "F").toUpperCase();
  const byteOrder = (text.$BYTEORD || "1,2,3,4").replace(/\s+/g, "");
  const littleEndian = byteOrderIsLittleEndian(byteOrder);
  const layout = rowByteLayout(text, parameterCount, dtype);
  const rowSize = layout.reduce((sum, bytes) => sum + bytes, 0);
  const offsets = layout.reduce<number[]>((acc, bytes, index) => {
    acc[index] = index === 0 ? 0 : acc[index - 1] + layout[index - 1];
    return acc;
  }, []);
  const { begin, end } = dataBounds(header, text);
  const dataLength = end - begin + 1;
  const buffer = await fs.readFile(path);
  const view = new DataView(buffer.buffer, buffer.byteOffset + begin, dataLength);
  const targetEvents = maxEvents && maxEvents > 0 ? Math.min(maxEvents, totalEvents) : totalEvents;
  const stride = Math.max(1, Math.ceil(totalEvents / targetEvents));
  const sampledEvents = Math.ceil(totalEvents / stride);
  const xs = new Float64Array(sampledEvents);
  const ys = new Float64Array(sampledEvents);

  let cursor = 0;
  for (let row = 0; row < totalEvents && cursor < sampledEvents; row += stride) {
    const rowOffset = row * rowSize;
    xs[cursor] = readValue({
      view,
      offset: rowOffset + offsets[xIndex],
      dtype,
      bytes: layout[xIndex],
      littleEndian,
    });
    ys[cursor] = readValue({
      view,
      offset: rowOffset + offsets[yIndex],
      dtype,
      bytes: layout[yIndex],
      littleEndian,
    });
    cursor += 1;
  }

  return {
    x: cursor === xs.length ? xs : xs.slice(0, cursor),
    y: cursor === ys.length ? ys : ys.slice(0, cursor),
    totalEvents,
  };
}
