/**
 * Ambient declarations for the tree-sitter grammar packages — none of them
 * ship their own type declarations. Most modules' default export is the
 * compiled Language object that tree-sitter's Parser.setLanguage consumes;
 * the older HTML/CSS bindings export { language, nodeTypeInfo } and core
 * 0.25 accepts that whole object. The shapes are asserted at runtime by the
 * loader's fail-open try/catch and the real-grammar smoke tests, not by
 * these types.
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
declare module "@tree-sitter-grammars/tree-sitter-yaml" {
  const grammar: object;
  export default grammar;
}
// HTML/CSS bindings predate the default-is-the-language convention.
declare module "tree-sitter-html" {
  const binding: { language: object };
  export default binding;
}
declare module "tree-sitter-css" {
  const binding: { language: object };
  export default binding;
}
