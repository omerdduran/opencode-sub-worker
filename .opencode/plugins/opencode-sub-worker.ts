// Local dev loader for opencode-sub-worker.
//
// OpenCode auto-discovers plugin files under `.opencode/plugins/` and calls the
// default export. This re-exports the built plugin so running `opencode` from
// this repo root loads the real artifact.
//
// Build first:  npm run build
export { default } from "../../dist/index.js"
