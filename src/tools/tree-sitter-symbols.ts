import path from "node:path";
import Parser from "web-tree-sitter";
import type {
  RawToolResult,
  TreeSitterSymbolsInput,
} from "./contracts";
import { ToolExecutionError } from "./errors";
import { readFile } from "node:fs/promises";
import { resolveRepoChild, validateRepoPath } from "./path-utils";

type LanguageName = "python" | "javascript" | "typescript" | "tsx";

type SymbolRecord = {
  kind: string;
  name: string;
  startLine: number;
  endLine: number;
};

const WASM_DIRECTORY = path.resolve(
  import.meta.dir,
  "../../node_modules/tree-sitter-wasms/out",
);

let initialized: Promise<void> | null = null;
const languages = new Map<LanguageName, Promise<Parser.Language>>();

function languageForExtension(extension: string): LanguageName | null {
  switch (extension) {
    case ".py":
      return "python";
    case ".js":
    case ".jsx":
      return "javascript";
    case ".ts":
      return "typescript";
    case ".tsx":
      return "tsx";
    default:
      return null;
  }
}

async function loadLanguage(name: LanguageName): Promise<Parser.Language> {
  initialized ??= Parser.init();
  await initialized;

  let language = languages.get(name);
  if (!language) {
    language = Parser.Language.load(
      path.join(WASM_DIRECTORY, `tree-sitter-${name}.wasm`),
    );
    languages.set(name, language);
  }
  return language;
}

function symbolKind(nodeType: string): string | null {
  switch (nodeType) {
    case "function_definition":
    case "function_declaration":
      return "function";
    case "class_definition":
    case "class_declaration":
      return "class";
    case "method_definition":
      return "method";
    case "interface_declaration":
      return "interface";
    case "type_alias_declaration":
      return "type";
    default:
      return null;
  }
}

function collectSymbols(
  node: Parser.SyntaxNode,
  symbols: SymbolRecord[],
): void {
  const kind = symbolKind(node.type);
  if (kind) {
    const name = node.childForFieldName("name")?.text;
    if (name) {
      symbols.push({
        kind,
        name,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
      });
    }
  }

  if (node.type === "variable_declarator") {
    const valueType = node.childForFieldName("value")?.type;
    const name = node.childForFieldName("name")?.text;
    if (
      name &&
      (valueType === "arrow_function" ||
        valueType === "function" ||
        valueType === "function_expression")
    ) {
      symbols.push({
        kind: "function",
        name,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
      });
    }
  }

  for (const child of node.namedChildren) {
    collectSymbols(child, symbols);
  }
}

export async function treeSitterSymbolsTool(
  input: TreeSitterSymbolsInput,
): Promise<RawToolResult> {
  const repoPath = await validateRepoPath(input.repoPath);
  const filePath = resolveRepoChild(repoPath, input.path);
  const languageName = languageForExtension(path.extname(input.path).toLowerCase());
  if (!languageName) {
    throw new ToolExecutionError(
      `Unsupported Tree-sitter file extension: ${path.extname(input.path) || "(none)"}`,
      "UNSUPPORTED_LANGUAGE",
    );
  }

  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch {
    throw new ToolExecutionError(
      `Source file could not be read: ${input.path}`,
      "FILE_NOT_FOUND",
    );
  }

  const language = await loadLanguage(languageName);
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  const symbols: SymbolRecord[] = [];

  try {
    collectSymbols(tree.rootNode, symbols);
    const output = symbols
      .map(
        (symbol) =>
          `${symbol.kind}\t${symbol.name}\t${symbol.startLine}:${symbol.endLine}`,
      )
      .join("\n");

    return {
      output,
      metadata: {
        path: input.path,
        language: languageName,
        symbolCount: symbols.length,
        hasParseErrors: tree.rootNode.hasError(),
      },
    };
  } finally {
    tree.delete();
    parser.delete();
  }
}
