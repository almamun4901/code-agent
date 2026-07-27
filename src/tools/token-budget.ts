import {
  decode as decodeO200k,
  encode as encodeO200k,
} from "gpt-tokenizer/encoding/o200k_base";
import type {
  RawToolResult,
  TokenCodec,
  ToolResult,
} from "./contracts";
import { ToolExecutionError } from "./errors";

export const TOOL_OUTPUT_TOKEN_LIMIT = 4_000;

export const O200K_CODEC: TokenCodec = {
  name: "o200k_base",
  encode: encodeO200k,
  decode: decodeO200k,
};

export function serializedTokenCount(
  result: ToolResult,
  codec: TokenCodec = O200K_CODEC,
): number {
  return codec.encode(JSON.stringify(result)).length;
}

export function finalizeToolResult(
  success: boolean,
  raw: RawToolResult,
  options: { codec?: TokenCodec; tokenLimit?: number } = {},
): ToolResult {
  const codec = options.codec ?? O200K_CODEC;
  const tokenLimit = options.tokenLimit ?? TOOL_OUTPUT_TOKEN_LIMIT;
  const outputTokens = codec.encode(raw.output);
  const base = {
    success,
    truncated: false,
    originalTokenCount: outputTokens.length,
    codec: codec.name,
    ...(raw.metadata ? { metadata: raw.metadata } : {}),
  };
  const full: ToolResult = { ...base, output: raw.output };

  if (serializedTokenCount(full, codec) <= tokenLimit) {
    return full;
  }

  let low = 0;
  let high = outputTokens.length;
  let best: ToolResult | null = null;

  while (low <= high) {
    const keep = Math.floor((low + high) / 2);
    const headCount = Math.ceil(keep * 0.7);
    const tailCount = keep - headCount;
    const omitted = outputTokens.length - keep;
    const marker = `\n\n[... ${omitted} ${codec.name} tokens omitted ...]\n\n`;
    const output =
      codec.decode(outputTokens.slice(0, headCount)) +
      marker +
      codec.decode(
        tailCount === 0 ? [] : outputTokens.slice(outputTokens.length - tailCount),
      );
    const candidate: ToolResult = {
      ...base,
      output,
      truncated: true,
    };

    if (serializedTokenCount(candidate, codec) <= tokenLimit) {
      best = candidate;
      low = keep + 1;
    } else {
      high = keep - 1;
    }
  }

  if (!best) {
    throw new ToolExecutionError(
      "Tool metadata alone exceeds the configured token limit.",
      "RESULT_METADATA_TOO_LARGE",
    );
  }

  return best;
}
