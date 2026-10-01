// Bundles the Milkdown editor + humd's custom-syntax plugins into ONE vendored
// ESM file the app loads directly (no bundler in the app itself).
//
//   npm run build   ->   ../src/js/vendor/milkdown.bundle.js
//
// The desktop build (build_app.sh / PyInstaller) ships the committed bundle and
// never runs this. Re-run after changing anything in this folder.
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const outfile = resolve(here, "../src/js/vendor/milkdown.bundle.js");

await esbuild.build({
  entryPoints: [resolve(here, "src/entry.js")],
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  outfile,
  legalComments: "none",
  logLevel: "info",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});

console.log("wrote", outfile);
