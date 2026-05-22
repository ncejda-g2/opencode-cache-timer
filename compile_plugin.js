import babel from "@babel/core";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

try {
  console.log("Compiling cache-timer.tsx to tui.js...");
  const srcPath = path.join(__dirname, "cache-timer.tsx");
  const destPath = path.join(__dirname, "tui.js");

  const code = fs.readFileSync(srcPath, "utf8");

  const result = babel.transformSync(code, {
    filename: "cache-timer.tsx",
    presets: [
      "@babel/preset-typescript",
      ["babel-preset-solid", { generate: "universal", moduleName: "@opentui/solid" }]
    ],
    sourceType: "module",
    sourceMaps: false
  });

  fs.writeFileSync(destPath, result.code);
  console.log("Compilation successful! Saved to tui.js");
} catch (err) {
  console.error("Compilation failed with error:", err);
}
