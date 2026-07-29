import type { ModelToolRequest } from "./contracts";
import { ToolExecutionError } from "./errors";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new ToolExecutionError(message, "INVALID_TOOL_CALL");
}

function requireRecord(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value)) invalid(`${label} must be an object.`);
  return value;
}

function requireString(
  input: UnknownRecord,
  key: string,
  options: { nullable?: boolean; nonEmpty?: boolean } = {},
): void {
  const value = input[key];
  if (options.nullable && value === null) return;
  if (typeof value !== "string") invalid(`${key} must be a string.`);
  if (options.nonEmpty && value.length === 0) {
    invalid(`${key} must not be empty.`);
  }
}

function optionalString(input: UnknownRecord, key: string): void {
  if (input[key] !== undefined && typeof input[key] !== "string") {
    invalid(`${key} must be a string when provided.`);
  }
}

function optionalBoolean(input: UnknownRecord, key: string): void {
  if (input[key] !== undefined && typeof input[key] !== "boolean") {
    invalid(`${key} must be a boolean when provided.`);
  }
}

function optionalInteger(input: UnknownRecord, key: string): void {
  if (
    input[key] !== undefined &&
    (typeof input[key] !== "number" || !Number.isInteger(input[key]))
  ) {
    invalid(`${key} must be an integer when provided.`);
  }
}

function rejectUnknownKeys(
  input: UnknownRecord,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(input).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    invalid(`${label} contains unknown fields: ${unknown.sort().join(", ")}.`);
  }
}

export function validateToolCall(value: unknown): ModelToolRequest {
  const call = requireRecord(value, "Tool call");
  rejectUnknownKeys(call, ["name", "input"], "Tool call");
  if (typeof call.name !== "string" || !("input" in call)) {
    invalid("Tool call requires string name and object input.");
  }
  const input = requireRecord(call.input, "Tool input");

  switch (call.name) {
    case "read_file":
      rejectUnknownKeys(
        input,
        ["path", "startLine", "endLine"],
        "read_file input",
      );
      requireString(input, "path", { nonEmpty: true });
      optionalInteger(input, "startLine");
      optionalInteger(input, "endLine");
      break;
    case "edit_file":
      rejectUnknownKeys(
        input,
        [
          "path",
          "mode",
          "oldText",
          "newText",
          "replaceAll",
          "baseVersion",
        ],
        "edit_file input",
      );
      requireString(input, "path", { nonEmpty: true });
      if (input.mode !== "preview" && input.mode !== "apply") {
        invalid("mode must be preview or apply.");
      }
      requireString(input, "oldText", { nullable: true });
      requireString(input, "newText");
      optionalBoolean(input, "replaceAll");
      optionalString(input, "baseVersion");
      break;
    case "ripgrep":
      rejectUnknownKeys(
        input,
        [
          "pattern",
          "path",
          "glob",
          "caseSensitive",
          "fixedString",
        ],
        "ripgrep input",
      );
      requireString(input, "pattern", { nonEmpty: true });
      optionalString(input, "path");
      optionalString(input, "glob");
      optionalBoolean(input, "caseSensitive");
      optionalBoolean(input, "fixedString");
      break;
    case "tree_sitter_symbols":
      rejectUnknownKeys(input, ["path"], "tree_sitter_symbols input");
      requireString(input, "path", { nonEmpty: true });
      break;
    case "run_shell":
      rejectUnknownKeys(
        input,
        ["cwd", "command", "timeoutMs"],
        "run_shell input",
      );
      requireString(input, "cwd", { nonEmpty: true });
      requireString(input, "command", { nonEmpty: true });
      optionalInteger(input, "timeoutMs");
      break;
    case "git":
      if (
        input.subcommand !== "status" &&
        input.subcommand !== "diff" &&
        input.subcommand !== "commit"
      ) {
        invalid("git subcommand must be status, diff, or commit.");
      }
      if (input.subcommand === "diff") {
        rejectUnknownKeys(input, ["subcommand", "staged", "path"], "git diff input");
        optionalBoolean(input, "staged");
        optionalString(input, "path");
      } else if (input.subcommand === "commit") {
        rejectUnknownKeys(
          input,
          ["subcommand", "message", "addAll"],
          "git commit input",
        );
        requireString(input, "message", { nonEmpty: true });
        if (typeof input.addAll !== "boolean") {
          invalid("addAll must be a boolean.");
        }
      } else {
        rejectUnknownKeys(input, ["subcommand"], "git status input");
      }
      break;
    default:
      throw new ToolExecutionError(
        `Unknown tool: ${String(call.name)}`,
        "UNKNOWN_TOOL",
      );
  }

  return value as ModelToolRequest;
}
