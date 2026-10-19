/**
 * Ambient declarations for the tree-sitter grammar packages — none of them
 * ship their own type declarations. Each module's default export is the
 * compiled Language object that tree-sitter's Parser.setLanguage consumes.
 * The shapes are asserted at runtime by the loader's fail-open try/catch and
 * the real-grammar smoke tests, not by these types.
 */
declare module "tree-sitter-javascript" {
  const grammar: object;
  export default grammar;
}
declare module "tree-sitter-python" {
  const grammar: object;
  export default grammar;
}
declare module "tree-sitter-json" {
  const grammar: object;
  export default grammar;
}
declare module "tree-sitter-go" {
  const grammar: object;
  export default grammar;
}
declare module "tree-sitter-rust" {
  const grammar: object;
  export default grammar;
}
declare module "tree-sitter-typescript" {
  const grammars: { typescript: object; tsx: object };
  export default grammars;
}
