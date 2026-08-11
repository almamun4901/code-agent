export type ReadFileInput = {
  repoPath: string;
  path: string;
  startLine?: number;
  endLine?: number;
};

export type EditFileInput = {
  repoPath: string;
  path: string;
  mode: "preview" | "apply";
  oldText: string | null;
  newText: string;
  replaceAll?: boolean;
  baseVersion?: string;
};

export type RipgrepInput = {
  repoPath: string;
  pattern: string;
  path?: string;
  glob?: string;
  caseSensitive?: boolean;
  fixedString?: boolean;
};

export type TreeSitterSymbolsInput = {
  repoPath: string;
  path: string;
};

export type RunShellInput = {
  repoPath: string;
  cwd: string;
  command: string;
  timeoutMs?: number;
  verificationRequirementId?: string;
};

export type VerifyViewportInput = {
  repoPath: string;
  verificationRequirementId: string;
};

export type GitInput =
  | { repoPath: string; subcommand: "status" }
  | {
      repoPath: string;
      subcommand: "diff";
      staged?: boolean;
      path?: string;
    }
  | {
      repoPath: string;
      subcommand: "commit";
      message: string;
      addAll: boolean;
    };

export type RootedToolCall =
  | { name: "read_file"; input: ReadFileInput }
  | { name: "edit_file"; input: EditFileInput }
  | { name: "ripgrep"; input: RipgrepInput }
  | { name: "tree_sitter_symbols"; input: TreeSitterSymbolsInput }
  | { name: "run_shell"; input: RunShellInput }
  | { name: "verify_viewport"; input: VerifyViewportInput }
  | { name: "git"; input: GitInput };

type WithoutRepoPath<T> = T extends { repoPath: string }
  ? Omit<T, "repoPath">
  : never;

export type ModelToolRequest =
  | { name: "read_file"; input: WithoutRepoPath<ReadFileInput> }
  | { name: "edit_file"; input: WithoutRepoPath<EditFileInput> }
  | { name: "ripgrep"; input: WithoutRepoPath<RipgrepInput> }
  | {
      name: "tree_sitter_symbols";
      input: WithoutRepoPath<TreeSitterSymbolsInput>;
    }
  | { name: "run_shell"; input: WithoutRepoPath<RunShellInput> }
  | { name: "verify_viewport"; input: WithoutRepoPath<VerifyViewportInput> }
  | { name: "git"; input: WithoutRepoPath<GitInput> };

export type ToolCall = ModelToolRequest;

export function isMutatingToolCall(call: ModelToolRequest): boolean {
  switch (call.name) {
    case "edit_file":
      return call.input.mode === "apply";
    case "run_shell":
    case "verify_viewport":
      return true;
    case "git":
      return call.input.subcommand === "commit";
    case "read_file":
    case "ripgrep":
    case "tree_sitter_symbols":
      return false;
  }
}

export type ToolMetadata = Record<
  string,
  string | number | boolean | null | undefined
>;

export type ToolResult = {
  success: boolean;
  output: string;
  truncated: boolean;
  originalTokenCount: number;
  codec: string;
  metadata?: ToolMetadata;
};

export type RawToolResult = {
  output: string;
  metadata?: ToolMetadata;
};

export type PreToolUseDecision =
  | { outcome: "allow" }
  | { outcome: "deny"; code: string; reason: string };

export type PreToolUseContext = {
  worktreeRoot: string;
  abortSignal?: AbortSignal;
};

export type PreToolUse = (
  request: ModelToolRequest,
  context: PreToolUseContext,
) => Promise<PreToolUseDecision>;

export type PreToolUseObservation = {
  index: number;
  durationMs: number;
  outcome: "allow" | "deny" | "failed" | "cancelled";
};

export type ToolExecutionQueue = {
  run<T>(operation: () => Promise<T>): Promise<T>;
};

export type DispatcherContext = PreToolUseContext & {
  abortSignal?: AbortSignal;
  preToolUse?: PreToolUse;
  observePreToolUse?: (observation: PreToolUseObservation) => void;
  executionQueue?: ToolExecutionQueue;
  tokenLimit?: number;
  tokenCodec?: TokenCodec;
};

export type TokenCodec = {
  name: string;
  encode(text: string): number[];
  decode(tokens: Iterable<number>): string;
};
