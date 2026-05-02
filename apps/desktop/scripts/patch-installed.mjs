#!/usr/bin/env node
/**
 * Incremental update: rebuilds changed code and patches the installed exe
 * in-place. Does NOT touch user data (pgsql-data, settings).
 *
 * Flow:
 *   1. electron-vite build  (TS → JS)
 *   2. Copy out/ → installed resources/app.asar (or app/ for unpacked dev)
 *   3. Copy resources/bin/*.exe → installed app.asar.unpacked/resources/bin/
 *
 * Usage: node scripts/patch-installed.mjs
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const outDir = join(desktopRoot, "out");

// NSIS oneClick installs to %LOCALAPPDATA%\Programs\<productName>
const installDir = join(
  process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
  "Programs",
  "@multicadesktop",
);

if (!existsSync(installDir)) {
  console.error(`[patch] Install not found at: ${installDir}`);
  console.error("[patch] Run the full installer first, then use this for updates.");
  process.exit(1);
}

console.log("[patch] Building...");
execSync("pnpm electron-vite build", { cwd: desktopRoot, stdio: "inherit" });

// --- Patch renderer (interleaved inside app.asar) ---
// For incremental updates, the simplest approach is to copy the entire
// out/ directory into the install. Electron-vite builds renderer assets
// with content-hashed filenames, so old files are harmless.
const asarRoot = join(installDir, "resources", "app.asar");
if (existsSync(asarRoot)) {
  // app.asar is an archive — we can't write into it directly.
  // Instead, copy the renderer files to the unpacked renderer location.
  // Actually, this doesn't work cleanly. Better approach:
  // Use `asar` tool to extract, replace, repack.

  console.log("[patch] Extracting app.asar...");
  const tmpDir = join(desktopRoot, ".patch-tmp");
  execSync(`npx asar extract "${asarRoot}" "${tmpDir}"`, { stdio: "inherit" });

  // Replace renderer files
  const rendererOut = join(outDir, "renderer");
  const rendererTarget = join(tmpDir, "out", "renderer");
  if (existsSync(rendererOut)) {
    console.log("[patch] Updating renderer...");
    if (existsSync(rendererTarget)) {
      execSync(`xcopy /E /Y /Q "${rendererOut}\\*" "${rendererTarget}\\"`, {
        stdio: "inherit",
        shell: true,
      });
    }
  }

  // Replace main + preload
  for (const sub of ["main", "preload"]) {
    const src = join(outDir, sub);
    const dst = join(tmpDir, "out", sub);
    if (existsSync(src) && existsSync(dst)) {
      console.log(`[patch] Updating ${sub}...`);
      execSync(`xcopy /E /Y /Q "${src}\\*" "${dst}\\"`, {
        stdio: "inherit",
        shell: true,
      });
    }
  }

  // Repack
  console.log("[patch] Repacking app.asar...");
  execSync(`npx asar pack "${tmpDir}" "${asarRoot}"`, { stdio: "inherit" });

  // Cleanup
  execSync(`rmdir /S /Q "${tmpDir}"`, { stdio: "inherit", shell: true });
} else {
  console.log("[patch] No app.asar found — skipping asar update");
}

// --- Patch Go binaries (unpacked from asar) ---
const unpackedBinDir = join(
  installDir,
  "resources",
  "app.asar.unpacked",
  "resources",
  "bin",
);
const srcBinDir = join(desktopRoot, "resources", "bin");

if (existsSync(unpackedBinDir)) {
  console.log("[patch] Updating Go binaries...");
  for (const name of readdirSync(srcBinDir)) {
    if (!name.endsWith(".exe")) continue;
    const src = join(srcBinDir, name);
    const dst = join(unpackedBinDir, name);
    console.log(`[patch]   ${name}`);
    copyFileSync(src, dst);
  }
}

console.log("[patch] Done. Restart Multica to apply.");
