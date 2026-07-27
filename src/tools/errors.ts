export class ToolExecutionError extends Error {
  readonly code: string;
  readonly exitCode: number | undefined;

  constructor(message: string, code = "TOOL_EXECUTION_ERROR", exitCode?: number) {
    super(message);
    this.name = "ToolExecutionError";
    this.code = code;
    this.exitCode = exitCode;
  }
}
