/**
 * A `.wasm` imported as a file asset resolves to the path it lands at, which
 * is what Bun's `with { type: 'file' }` produces. TypeScript has no builtin
 * notion of that, so it is declared here.
 */
declare module '*.wasm' {
  const path: string;
  export default path;
}
