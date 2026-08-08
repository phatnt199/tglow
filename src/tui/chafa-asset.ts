/**
 * The WebAssembly, imported purely so the bundler carries it.
 *
 * chafa's loader opens `chafa.wasm` beside itself by path -- it offers no hook
 * to hand it bytes -- so the only way into a `bun build --compile` binary is
 * to have Bun embed it as an asset under its own plain name. Nothing reads
 * this value; the import is the whole point, which is why it is a module of
 * its own rather than a stray line somebody would tidy away.
 */
import wasmPath from '../../node_modules/chafa-wasm/dist/chafa.wasm' with { type: 'file' };

export const CHAFA_WASM_PATH = wasmPath;
