#!/usr/bin/env node
// Compares a project's theme CSS against the published @molca/molca-theme.
// Usage: node verify-theme.mjs <path/to/index.css> [registry-url]
// Exits 1 when any token is missing or differs, so it can gate a commit.

import { readFileSync } from "node:fs";

const [cssPath, registry = "https://molca-web-ui-kit.vercel.app/r"] = process.argv.slice(2);
if (!cssPath) {
  console.error("usage: node verify-theme.mjs <path/to/index.css> [registry-url]");
  process.exit(2);
}

const theme = await (await fetch(`${registry}/molca-theme.json`)).json();
const css = readFileSync(cssPath, "utf8");

// Reads `--name: value;` pairs from the first top-level block opened by `selector {`.
function readBlock(selector) {
  const start = css.search(
    new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`, "m"),
  );
  if (start === -1) return null;
  const end = css.indexOf("\n}", start);
  const vars = {};
  for (const [, name, value] of css.slice(start, end).matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    vars[name] = value.trim();
  }
  return vars;
}

const norm = (v) => v.replace(/\s+/g, " ").toLowerCase();
const blocks = {
  theme: readBlock("@theme inline"),
  light: readBlock(":root"),
  dark: readBlock(".dark"),
};

let problems = 0;
for (const [mode, expected] of Object.entries(theme.cssVars)) {
  const actual = blocks[mode];
  if (!actual) {
    console.log(`✗ ${mode}: block not found in ${cssPath}`);
    problems++;
    continue;
  }
  for (const [name, value] of Object.entries(expected)) {
    if (!(name in actual)) {
      console.log(`✗ ${mode} --${name}: missing (expected ${value})`);
      problems++;
    } else if (norm(actual[name]) !== norm(value)) {
      console.log(`✗ ${mode} --${name}: ${actual[name]} (expected ${value})`);
      problems++;
    }
  }
}

const total = Object.values(theme.cssVars).reduce((n, v) => n + Object.keys(v).length, 0);
console.log(
  problems
    ? `\n${problems} of ${total} tokens differ from @molca/molca-theme`
    : `✓ all ${total} tokens match @molca/molca-theme`,
);
process.exit(problems ? 1 : 0);
