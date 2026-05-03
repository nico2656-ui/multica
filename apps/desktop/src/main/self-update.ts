/**
 * Self-update: rebuild from local repo and apply changes without full reinstall.
 *
 * The user configures their local repo path once (Settings → 更新).
 * The button then: pulls latest code → builds → prepares pending-update files.
 * On next app launch, applyPendingUpdate() swaps the new files in.
 *
 * Data in %APPDATA% is never touched.
 */
import { app, ipcMain, BrowserWindow } from "electron";
import { spawn } from "child_process";
import { existsSync, copyFileSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---- Config ----

const PREFS_PATH = join(app.getPath("userData"), "update-prefs.json");

function loadRepoPath(): string | null {
  try {
    const raw = readFileSync(PREFS_PATH, "utf-8");
    const cfg = JSON.parse(raw);
    return typeof cfg.repoPath === "string" ? cfg.repoPath : null;
  } catch {
    return null;
  }
}

function saveRepoPath(path: string): void {
  writeFileSync(PREFS_PATH, JSON.stringify({ repoPath: path }), "utf-8");
}

function autoDetectRepoPath(): string | null {
  const candidates = [
    join(homedir(), "Documents", "GitHub", "multica"),
    join(homedir(), "Documents", "GitHub", "leo-multica"),
    join(homedir(), "projects", "multica"),
    join(homedir(), "multica"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
  }
  return null;
}

// ---- Paths ----

const installDir = join(
  process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
  "Programs",
  "@multicadesktop",
);
const pendingDir = join(app.getPath("userData"), "pending-update");

// ---- Helpers ----

function sendUpdateProgress(win: BrowserWindow | null, msg: string): void {
  console.log("[update]", msg);
  try {
    if (win && !win.isDestroyed()) {
      win.webContents.send("server:progress", {
        stage: "ready",
        message: `[更新] ${msg}`,
        log: "",
  });
    }
  } catch {
    // Window destroyed during restart — ignore
  }
}

function spawnAsync(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: true });
    let out = "";
    proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (out += d.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} ${args.join(" ")} failed (exit ${code}): ${out.slice(-200)}`));
    });
    proc.on("error", reject);
  });
}

// ---- Apply pending swap on startup ----

export function applyPendingUpdate(): void {
  if (!existsSync(pendingDir)) return;

  const newAsar = join(pendingDir, "app.asar");
  if (!existsSync(newAsar)) {
    // Stale partial dir — clean it up
    try { rmSync(pendingDir, { recursive: true, force: true }); } catch {}
    return;
  }

  console.log("[update] Applying pending update...");

  // Write a swap script that runs after the app exits.
  // Windows locks running app.asar so we can't overwrite it in-process.
  const targetAsar = join(installDir, "resources", "app.asar");
  const swapBat = join(app.getPath("temp"), "multica-swap.bat");

  // Batch script: wait for app to exit, then swap files
  const batContent = [
    "@echo off",
    ":retry",
    `if exist "${targetAsar}" (`,
    `  move /Y "${newAsar}" "${targetAsar}"`,
    `) else (`,
    "  timeout /t 1 >nul",
    "  goto retry",
    ")",
    // Copy binaries
    `xcopy /Y /Q "${join(pendingDir, 'bin', '*.exe')}" "${join(installDir, 'resources', 'app.asar.unpacked', 'resources', 'bin')}\\"`,
    `rmdir /S /Q "${pendingDir}"`,
    `del "%~f0"`,
  ].join("\r\n");

  try {
    writeFileSync(swapBat, batContent);
    // Spawn detached — runs after we exit because it waits for the target
    spawn("cmd.exe", ["/c", swapBat], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    console.log("[update] Swap script launched — will apply on exit");
  } catch (err) {
    console.error("[update] Failed to create swap script:", err);
    // Fallback: try copy right now (may fail if locked)
    try { copyFileSync(newAsar, targetAsar); } catch {}
  }
}

// ---- IPC handlers ----

export function setupSelfUpdate(getMainWindow: () => BrowserWindow | null): void {
  // Get/set repo path
  ipcMain.handle("update:get-repo-path", () => {
    const saved = loadRepoPath();
    if (saved && existsSync(join(saved, "pnpm-workspace.yaml"))) return { path: saved };
    const detected = autoDetectRepoPath();
    return { path: detected || null };
  });

  ipcMain.handle("update:set-repo-path", (_e, path: string) => {
    if (existsSync(join(path, "pnpm-workspace.yaml"))) {
      saveRepoPath(path);
      return { success: true };
    }
    return { success: false, error: "该目录下未找到 pnpm-workspace.yaml，请确认是项目根目录" };
  });

  // Trigger rebuild
  ipcMain.handle("update:rebuild", async () => {
    const win = getMainWindow();
    const repoRoot = loadRepoPath();

    if (!repoRoot) {
      sendUpdateProgress(win, "请先在设置中配置项目仓库路径");
      return { success: false, error: "repo path not configured" };
    }

    if (!existsSync(join(repoRoot, "pnpm-workspace.yaml"))) {
      sendUpdateProgress(win, "项目路径无效，请重新配置");
      return { success: false, error: "invalid repo path" };
    }

    try {
      // Step 1: git pull
      sendUpdateProgress(win, "git pull 拉取最新代码...");
      await spawnAsync("git", ["pull"], repoRoot);

      // Step 2: install deps
      sendUpdateProgress(win, "安装依赖...");
      await spawnAsync("pnpm", ["install", "--frozen-lockfile"], repoRoot);

      // Step 3: build frontend
      sendUpdateProgress(win, "编译前端...");
      await spawnAsync("pnpm", ["--filter", "@multica/desktop", "build"], repoRoot);

      // Step 4: build Go server (best-effort)
      try {
        sendUpdateProgress(win, "编译 Go 后端...");
        await spawnAsync("node", ["scripts/bundle-server.mjs"], join(repoRoot, "apps", "desktop"));
      } catch {
        sendUpdateProgress(win, "Go 编译跳过 (未安装 Go)");
      }

      // Step 5: prepare pending update
      sendUpdateProgress(win, "准备更新文件...");
      try { rmSync(pendingDir, { recursive: true, force: true }); } catch {}
      mkdirSync(pendingDir, { recursive: true });

      // Build app.asar from out/
      sendUpdateProgress(win, "打包 app.asar...");
      try {
        await spawnAsync("npx", ["asar", "pack", "out", join(pendingDir, "app.asar")], join(repoRoot, "apps", "desktop"));
      } catch {
        sendUpdateProgress(win, "asar 打包失败");
        return { success: false, error: "asar pack failed" };
      }

      // Copy Go binaries
      const srcBin = join(repoRoot, "apps", "desktop", "resources", "bin");
      const dstBin = join(pendingDir, "bin");
      mkdirSync(dstBin, { recursive: true });
      for (const name of readdirSync(srcBin)) {
        if (name.endsWith(".exe")) copyFileSync(join(srcBin, name), join(dstBin, name));
      }

      sendUpdateProgress(win, "更新已就绪，请重启应用");
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendUpdateProgress(win, `更新失败: ${msg}`);
      return { success: false, error: msg };
    }
  });

  ipcMain.handle("update:restart", () => {
    app.relaunch();
    app.exit(0);
  });
}
