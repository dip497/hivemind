/**
 * The syntax provider: a file's outline and the lines that fold, from tree-sitter's parse of the
 * text alone. One query per language finds the declarations (`@definition.<kind>` on the whole
 * declaration, `@name` on its name) and the blocks that fold (`@fold`); nesting comes from where
 * each one is. Loaded the same way beside the editor (a Worker) and in the sidecar (Node); only
 * how the .wasm files are read differs.
 */
import type { CodeSymbol, FoldRange, LanguageId, Place, SymbolKind } from "./contract.js";
import type { Language as TsLanguage, Node as TsNode, Parser as TsParser, Query as TsQuery } from "@vscode/tree-sitter-wasm";

/** The tree-sitter module (its UMD build, however the loader hands it over). */
export interface TreeSitterModule {
  Parser: typeof TsParser;
  Language: typeof TsLanguage;
  Query: typeof TsQuery;
}

/** Reads one of the package's .wasm files by its name without `.wasm`: `tree-sitter` is the
 *  runtime, `tree-sitter-<grammar>` a language. */
export type WasmReader = (name: string) => Promise<Uint8Array>;

const GRAMMAR: Record<LanguageId, string> = {
  typescript: "typescript", tsx: "tsx", javascript: "javascript", python: "python", rust: "rust", go: "go", java: "java",
};

const TS_SHARED = `
(function_declaration name: (_) @name) @definition.function
(generator_function_declaration name: (_) @name) @definition.function
(class_declaration name: (_) @name) @definition.class
(method_definition name: (_) @name) @definition.method
(program (lexical_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @definition.function))
(program (export_statement (lexical_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @definition.function)))
(program (lexical_declaration (variable_declarator name: (identifier) @name) @definition.constant))
(program (export_statement (lexical_declaration (variable_declarator name: (identifier) @name) @definition.constant)))
[(statement_block) (class_body) (object) (array) (arguments) (template_string) (comment) (switch_body) (named_imports) (formal_parameters)] @fold
`;
const TS_TYPES = `
(abstract_class_declaration name: (_) @name) @definition.class
(interface_declaration name: (_) @name) @definition.interface
(type_alias_declaration name: (_) @name) @definition.type
(enum_declaration name: (_) @name) @definition.enum
(internal_module name: (_) @name) @definition.module
(method_signature name: (_) @name) @definition.method
(abstract_method_signature name: (_) @name) @definition.method
(public_field_definition name: (_) @name) @definition.field
(property_signature name: (_) @name) @definition.property
[(interface_body) (enum_body) (object_type)] @fold
`;

const QUERIES: Record<LanguageId, string> = {
  typescript: TS_SHARED + TS_TYPES,
  tsx: TS_SHARED + TS_TYPES + "(jsx_element) @fold\n",
  javascript: TS_SHARED + "(field_definition property: (_) @name) @definition.field\n(jsx_element) @fold\n",
  python: `
(class_definition name: (identifier) @name) @definition.class
(function_definition name: (identifier) @name) @definition.function
(module (expression_statement (assignment left: (identifier) @name) @definition.variable))
[(class_definition) (function_definition) (dictionary) (list) (argument_list) (parameters) (string)] @fold
`,
  rust: `
(function_item name: (_) @name) @definition.function
(function_signature_item name: (_) @name) @definition.method
(struct_item name: (_) @name) @definition.class
(union_item name: (_) @name) @definition.class
(enum_item name: (_) @name) @definition.enum
(trait_item name: (_) @name) @definition.interface
(type_item name: (_) @name) @definition.type
(mod_item name: (_) @name) @definition.module
(const_item name: (_) @name) @definition.constant
(static_item name: (_) @name) @definition.constant
(macro_definition name: (_) @name) @definition.function
(impl_item type: (_) @name) @definition.class
(field_declaration name: (_) @name) @definition.field
(enum_variant name: (_) @name) @definition.constant
[(block) (declaration_list) (field_declaration_list) (enum_variant_list) (match_block) (arguments) (parameters) (use_list) (block_comment)] @fold
`,
  go: `
(function_declaration name: (_) @name) @definition.function
(method_declaration name: (_) @name) @definition.method
(type_spec name: (_) @name type: (struct_type)) @definition.class
(type_spec name: (_) @name type: (interface_type)) @definition.interface
(type_spec name: (_) @name type: [(type_identifier) (qualified_type) (generic_type) (pointer_type) (slice_type) (map_type) (array_type) (function_type) (channel_type)]) @definition.type
(source_file (const_declaration (const_spec name: (_) @name) @definition.constant))
(source_file (var_declaration (var_spec name: (_) @name) @definition.variable))
(field_declaration name: (_) @name) @definition.field
(method_elem name: (_) @name) @definition.method
[(block) (field_declaration_list) (interface_type) (literal_value) (argument_list) (import_spec_list) (const_declaration) (var_declaration) (comment)] @fold
`,
  java: `
(class_declaration name: (_) @name) @definition.class
(record_declaration name: (_) @name) @definition.class
(interface_declaration name: (_) @name) @definition.interface
(annotation_type_declaration name: (_) @name) @definition.interface
(enum_declaration name: (_) @name) @definition.enum
(enum_constant name: (_) @name) @definition.constant
(method_declaration name: (_) @name) @definition.method
(constructor_declaration name: (_) @name) @definition.constructor
(field_declaration declarator: (variable_declarator name: (_) @name)) @definition.field
[(class_body) (interface_body) (enum_body) (block) (constructor_body) (array_initializer) (argument_list) (block_comment)] @fold
`,
};

interface Loaded { parser: TsParser; query: TsQuery }

const placeOf = (p: { row: number; column: number }): Place => ({ line: p.row + 1, col: p.column });
const OWNS_METHODS = new Set<SymbolKind>(["class", "interface"]);

/** What one parse of a file gives. */
export interface FileShape { outline: CodeSymbol[]; folding: FoldRange[] }

export interface Syntax {
  /** The file's outline and folds from one parse; the same text asked again is not parsed again. */
  read(language: LanguageId, text: string): Promise<FileShape>;
}

/** The syntax provider's work, with the runtime started once and each grammar loaded on first use. */
export function createSyntax(treeSitter: TreeSitterModule, read: WasmReader): Syntax {
  let runtime: Promise<void> | null = null;
  const loaded = new Map<LanguageId, Promise<Loaded>>();
  const load = (language: LanguageId): Promise<Loaded> => {
    let l = loaded.get(language);
    if (!l) {
      l = (async () => {
        // The module takes any Emscripten option; its types name only `locateFile`.
        runtime ??= read("tree-sitter").then((wasmBinary) => treeSitter.Parser.init({ wasmBinary } as never));
        await runtime;
        const grammar = await treeSitter.Language.load(await read(`tree-sitter-${GRAMMAR[language]}`));
        const parser = new treeSitter.Parser();
        parser.setLanguage(grammar);
        return { parser, query: new treeSitter.Query(grammar, QUERIES[language]) };
      })();
      l.catch(() => loaded.delete(language));
      loaded.set(language, l);
    }
    return l;
  };

  let last: { language: LanguageId; text: string; shape: Promise<FileShape> } | null = null;
  return {
    read(language, text) {
      if (last?.language === language && last.text === text) return last.shape;
      const shape = load(language).then(({ parser, query }) => {
        const tree = parser.parse(text);
        if (!tree) throw new Error(`could not parse the ${language} text`);
        try { return { outline: outlineOf(tree.rootNode, query), folding: foldsOf(tree.rootNode, query) }; } finally { tree.delete(); }
      });
      last = { language, text, shape };
      shape.catch(() => { if (last?.shape === shape) last = null; });
      return shape;
    },
  };
}

function outlineOf(root: TsNode, query: TsQuery): CodeSymbol[] {
  // One symbol per declaration: where two patterns match it, the one listed first says what it is.
  const byNode = new Map<string, { symbol: CodeSymbol; start: number; end: number; pattern: number }>();
  for (const match of query.matches(root)) {
    const def = match.captures.find((c) => c.name.startsWith("definition."));
    const name = match.captures.find((c) => c.name === "name");
    if (!def || !name) continue;
    const key = `${def.node.startIndex}:${def.node.endIndex}`;
    if ((byNode.get(key)?.pattern ?? Infinity) <= match.patternIndex) continue;
    const kind = def.name.slice("definition.".length) as SymbolKind;
    byNode.set(key, {
      start: def.node.startIndex, end: def.node.endIndex, pattern: match.patternIndex,
      symbol: {
        name: kind === "class" && def.node.type === "impl_item" ? `impl ${name.node.text}` : name.node.text,
        kind: kind === "method" && name.node.text === "constructor" ? "constructor" : kind,
        span: { start: placeOf(def.node.startPosition), end: placeOf(def.node.endPosition) },
        nameAt: placeOf(name.node.startPosition),
        children: [],
      },
    });
  }
  return nest([...byNode.values()]);
}

function foldsOf(root: TsNode, query: TsQuery): FoldRange[] {
  const byStart = new Map<number, number>();
  for (const c of query.captures(root)) {
    if (c.name !== "fold") continue;
    const start = c.node.startPosition.row + 1;
    const end = c.node.endPosition.row + 1;
    if (end > start && end > (byStart.get(start) ?? 0)) byStart.set(start, end);
  }
  return [...byStart].sort((a, b) => a[0] - b[0]).map(([startLine, endLine]) => ({ startLine, endLine }));
}

/** Declarations in source order, each under the nearest one that holds it; a function directly
 *  inside a class or interface is its method. */
function nest(flat: { symbol: CodeSymbol; start: number; end: number }[]): CodeSymbol[] {
  flat.sort((a, b) => a.start - b.start || b.end - a.end);
  const top: CodeSymbol[] = [];
  const open: { symbol: CodeSymbol; end: number }[] = [];
  for (const f of flat) {
    while (open.length && open[open.length - 1]!.end <= f.start) open.pop();
    const parent = open[open.length - 1];
    if (parent && f.symbol.kind === "function" && OWNS_METHODS.has(parent.symbol.kind)) f.symbol.kind = "method";
    (parent ? parent.symbol.children : top).push(f.symbol);
    open.push({ symbol: f.symbol, end: f.end });
  }
  return top;
}
