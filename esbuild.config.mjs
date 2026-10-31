import esbuild from "esbuild";
import { cp, mkdir } from "node:fs/promises";

const production = process.argv.includes("production");
const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian"],
  platform: "browser",
  format: "cjs",
  target: "es2022",
  outfile: "main.js",
  sourcemap: production ? false : "inline",
  minify: production,
  logLevel: "info",
});

if (production) {
  await context.rebuild();
  await context.dispose();
  await mkdir("dist/split-preview", { recursive: true });
  for (const file of ["main.js", "manifest.json", "styles.css"]) {
    await cp(file, `dist/split-preview/${file}`);
  }
} else {
  await context.watch();
}
