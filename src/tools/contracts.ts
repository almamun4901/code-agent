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
    }
  | {
      repoPath: string;
      subcommand: "push";
      remote: string;
      branch: string;
    };

export type ToolCall =
  | { name: "read_file"; input: ReadFileInput }
  | { name: "edit_file"; input: EditFileInput }
  | { name: "ripgrep"; input: RipgrepInput }
  | { name: "tree_sitter_symbols"; input: TreeSitterSymbolsInput }
  | { name: "run_shell"; input: RunShellInput }
  | { name: "git"; input: GitInput };

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

export type BeforeToolUse = (
  call: ToolCall,
  context: DispatcherContext,
) => Promise<void>;

export type DispatcherContext = {
  developmentRoot?: string;
  beforeToolUse?: BeforeToolUse;
  tokenLimit?: number;
  tokenCodec?: TokenCodec;
};

export type TokenCodec = {
  name: string;
  encode(text: string): number[];
  decode(tokens: Iterable<number>): string;
};
