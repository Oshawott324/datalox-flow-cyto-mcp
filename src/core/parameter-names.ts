import { FlowcytoError, type SampleParameter } from "./types.js";

/** Resolve a channel given by parameter name or by detector ($PnN) to the parameter name. */
export function resolveParameterName(
  parameters: SampleParameter[],
  channel: string,
  errorPath: string,
  sampleId: string,
): string {
  if (parameters.some((parameter) => parameter.name === channel)) return channel;
  const wanted = channel.trim().toLowerCase();
  const matches = parameters.filter((parameter) =>
    parameter.name.toLowerCase() === wanted || (parameter.detector ?? "").toLowerCase() === wanted);
  if (matches.length === 1 && matches[0]) return matches[0].name;
  throw new FlowcytoError("unknown_parameter", `Parameter ${channel} is not present in sample ${sampleId}.`, errorPath);
}

/** Hint for validation messages: the parameter name a detector id belongs to, if any. */
export function detectorAliasHint(parameters: SampleParameter[], channel: string): string {
  const wanted = channel.trim().toLowerCase();
  const match = parameters.find((parameter) => (parameter.detector ?? "").toLowerCase() === wanted && parameter.name !== channel);
  return match ? ` ${channel} is the detector of parameter "${match.name}"; gates and views use the parameter name.` : "";
}
