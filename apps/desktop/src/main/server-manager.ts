import { app, BrowserWindow, ipcMain } from "electron";
import { spawn, execSync, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from "fs";
import { join } from "path";

const PG_PORT = 15432;
const PG_USER = "multica";
const PG_DB = "multica";
const SERVER_PORT = 8080;
const AUTO_LOGIN_EMAIL = "local@multica.desktop";
const AUTO_LOGIN_CODE = "000000";

// Startup stages (shown to user in order)
export type ServerStage =
  | "checking"
  | "init_pg"
  | "starting_pg"
  | "creating_db"
  | "running_migrations"
  | "starting_server"
  | "logging_in"
  | "ready"
  | "error";

export interface ServerProgress {
  stage: ServerStage;
  message: string;
  log: string;
}

interface ServerState {
  pgProcess: ChildProcess | null;
  serverProcess: ChildProcess | null;
  ready: boolean;
  starting: boolean;
  getMainWindow: () => BrowserWindow | null;
}

const state: ServerState = {
  pgProcess: null,
  serverProcess: null,
  ready: false,
  starting: false,
  getMainWindow: () => null,
};

// ---- Progress reporting ----

let latestProgress: ServerProgress = {
  stage: "checking",
  message: "等待后台服务启动...",
  log: "主进程正在加载",
};

function sendProgress(stage: ServerStage, message: string, log = ""): void {
  const payload: ServerProgress = { stage, message, log };
  latestProgress = payload;
  console.log(`[server:${stage}] ${message}${log ? " | " + log : ""}`);
  try {
    const win = state.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send("server:progress", payload);
    }
  } catch {
    // Window destroyed during restart — progress is still pollable
  }
}

// ---- Helpers ----

function unpackedDir(subdir: string): string {
  if (app.isPackaged) {
    return join(app.getAppPath(), "resources", subdir).replace(
      "app.asar",
      "app.asar.unpacked",
    );
  }
  return join(app.getAppPath(), "resources", subdir);
}

function pgsqlBinDir(): string {
  return unpackedDir("pgsql/bin");
}

function serverBinDir(): string {
  return unpackedDir("bin");
}

function dataDir(): string {
  const dir = join(app.getPath("userData"), "pgsql-data");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function pgIsInitialized(): boolean {
  if (!existsSync(join(dataDir(), "PG_VERSION"))) return false;
  const pgConf = join(dataDir(), "postgresql.conf");
  try {
    const conf = readFileSync(pgConf, "utf-8");
    if (conf.length < 500) {
      console.log("[server] Broken postgresql.conf detected — re-initializing");
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

function runCommand(
  exe: string,
  args: string[],
  env: Record<string, string> = {},
  timeout = 30_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(exe, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString().slice(-64_000)));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString().slice(-64_000)));

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Command timed out: ${exe} ${args.join(" ")}`));
    }, timeout);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(`${exe} failed (exit ${code}): ${stderr || stdout}`),
        );
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ---- Port cleanup (cross-platform) ----

function killStaleOnPort(port: number): void {
  try {
    if (process.platform === "win32") {
      const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, {
        encoding: "utf-8",
        timeout: 3000,
      }).trim();
      const match = out.match(/(\d+)\s*$/m);
      if (match) {
        try { execSync(`taskkill /F /PID ${match[1]}`, { timeout: 3000 }); } catch {}
      }
    } else {
      // macOS / Linux
      try {
        execSync(`lsof -ti :${port} | xargs kill -9 2>/dev/null || fuser -k ${port}/tcp 2>/dev/null || true`, {
          timeout: 3000,
        });
      } catch {}
    }
  } catch {
    /* no stale process */
  }
}

// ---- Startup steps ----

async function initPostgres(): Promise<void> {
  const binDir = pgsqlBinDir();
  const dir = dataDir();

  sendProgress("init_pg", "正在初始化数据库...", `initdb -D ${dir}`);
  await runCommand(
    join(binDir, "initdb.exe"),
    ["-D", dir, "-U", PG_USER, "-A", "trust", "--no-locale", "-E", "UTF8"],
    {},
    60_000,
  );

  // Write pg_hba.conf
  const hbaConf = join(dir, "pg_hba.conf");
  writeFileSync(
    hbaConf,
    [
      "# Local connections",
      `host   all   ${PG_USER}   127.0.0.1/32   trust`,
      `host   all   ${PG_USER}   ::1/128         trust`,
      "local  all   all                           trust",
    ].join("\n"),
  );

  // Append overrides — don't replace initdb's full config
  const pgConf = join(dir, "postgresql.conf");
  const overrides = [
    "",
    "# Multica desktop overrides",
    `port = ${PG_PORT}`,
    "listen_addresses = 'localhost'",
    "max_connections = 50",
  ].join("\n");
  try {
    const existing = readFileSync(pgConf, "utf-8");
    if (!existing.includes("Multica desktop overrides")) {
      writeFileSync(pgConf, existing + overrides + "\n");
    }
  } catch {
    writeFileSync(pgConf, overrides + "\n");
  }

  sendProgress("init_pg", "数据库初始化完成");
}

function startPostgres(): Promise<void> {
  return new Promise((resolve, reject) => {
    const binDir = pgsqlBinDir();
    const dir = dataDir();

    killStaleOnPort(PG_PORT);
    sendProgress("starting_pg", "正在启动 PostgreSQL...", `port=${PG_PORT}`);

    const proc = spawn(
      join(binDir, "postgres.exe"),
      ["-D", dir, "-p", String(PG_PORT)],
      {
        env: { ...process.env, PATH: `${binDir};${process.env.PATH || ""}` },
        cwd: binDir,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    let started = false;
    let outputBuf = "";

    // Listen to BOTH stdout and stderr for the ready signal
    function onData(d: Buffer): void {
      const msg = d.toString().trim();
      outputBuf += msg + "\n";
      if (msg) console.log("[pg]", msg);
      if (
        !started &&
        (msg.includes("ready to accept") ||
          msg.includes("database system is ready"))
      ) {
        started = true;
        state.pgProcess = proc;
        sendProgress("starting_pg", "PostgreSQL 已启动");
        resolve();
      }
    }

    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);

    proc.on("error", (err) => {
      sendProgress("error", "PostgreSQL 进程启动失败", err.message);
      reject(err);
    });

    proc.on("close", (code) => {
      if (!started) {
        sendProgress("error", "PostgreSQL 进程意外退出", `exit=${code}`);
        reject(new Error(`postgres exited with code ${code}`));
        return;
      }
      // PG crashed after successful start — attempt one automatic restart
      state.pgProcess = null;
      state.ready = false;
      console.log(`[server] PostgreSQL exited (code ${code}) — attempting restart`);
      startPostgres()
        .then(() => {
          state.ready = true;
          sendProgress("starting_pg", "PostgreSQL 已自动重启");
        })
        .catch((err) => {
          sendProgress("error", "PostgreSQL 重启失败", String(err));
        });
    });

    // Timeout
    setTimeout(() => {
      if (!started) {
        sendProgress(
          "error",
          "PostgreSQL 启动超时 (30s)",
          outputBuf.slice(-300),
        );
        reject(new Error("PostgreSQL startup timeout"));
      }
    }, 30_000);
  });
}

async function createDatabase(): Promise<void> {
  const binDir = pgsqlBinDir();
  sendProgress("creating_db", "正在创建数据库...");
  try {
    await runCommand(
      join(binDir, "createdb.exe"),
      ["-h", "localhost", "-p", String(PG_PORT), "-U", PG_USER, PG_DB],
    );
    sendProgress("creating_db", `数据库 "${PG_DB}" 已创建`);
  } catch {
    sendProgress("creating_db", `数据库 "${PG_DB}" 已存在`);
  }
}

async function runMigrations(): Promise<void> {
  const migrateExe = join(serverBinDir(), "migrate.exe");
  const dbURL = `postgres://${PG_USER}@localhost:${PG_PORT}/${PG_DB}?sslmode=disable`;

  if (!existsSync(migrateExe)) {
    throw new Error(`migrate binary not found at ${migrateExe}`);
  }

  sendProgress("running_migrations", "正在运行数据库迁移 (85 个文件)...");
  const output = await runCommand(migrateExe, ["up"], { DATABASE_URL: dbURL }, 120_000);
  sendProgress(
    "running_migrations",
    "数据库迁移完成",
    output.split("\n").slice(-3).join(" "),
  );
}

async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function startGoServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const serverExe = join(serverBinDir(), "server.exe");
    const dbURL = `postgres://${PG_USER}@localhost:${PG_PORT}/${PG_DB}?sslmode=disable`;

    if (!existsSync(serverExe)) {
      reject(new Error(`server binary not found at ${serverExe}`));
      return;
    }

    sendProgress(
      "starting_server",
      "正在启动 Multica 后端服务...",
      `port=${SERVER_PORT}`,
    );

    const proc = spawn(serverExe, [], {
      env: {
        ...process.env,
        PORT: String(SERVER_PORT),
        DATABASE_URL: dbURL,
        JWT_SECRET: "desktop-local-dev-secret",
        APP_ENV: "development",
        MULTICA_DEV_VERIFICATION_CODE: "000000",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let started = false;
    let outputBuf = "";
    let healthPoll: ReturnType<typeof setInterval> | null = null;

    proc.stdout.on("data", (d: Buffer) => {
      const msg = d.toString().trim();
      outputBuf += msg + "\n";
      console.log("[server]", msg);
      if (msg) sendProgress("starting_server", "后端服务启动中...", msg);
      if (
        !started &&
        (msg.includes("server starting") || msg.includes("listening"))
      ) {
        started = true;
        // Poll health endpoint before resolving (not just 500ms blind wait)
        healthPoll = setInterval(async () => {
          if (await isServerRunning()) {
            clearInterval(healthPoll!);
            state.serverProcess = proc;
            sendProgress("starting_server", "Multica 后端服务已启动");
            resolve();
          }
        }, 200);
        // Fail-safe: if health poll doesn't succeed in 10s, resolve anyway
        setTimeout(() => {
          if (healthPoll) {
            clearInterval(healthPoll);
            healthPoll = null;
          }
          if (started && state.serverProcess !== proc) {
            state.serverProcess = proc;
            resolve();
          }
        }, 10_000);
      }
    });

    proc.stderr.on("data", (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) {
        outputBuf += "[stderr] " + msg + "\n";
        sendProgress("starting_server", "后端服务启动中...", "[stderr] " + msg);
      }
      console.log("[server:err]", msg);
    });

    proc.on("error", (err) => {
      if (!started) {
        sendProgress("error", "后端服务启动失败", err.message);
        reject(err);
      }
    });

    proc.on("close", (code) => {
      if (healthPoll) clearInterval(healthPoll);
      state.serverProcess = null;
      if (!started) {
        sendProgress(
          "error",
          "后端服务意外退出",
          `exit=${code} | ${outputBuf.slice(-400)}`,
        );
        reject(
          new Error(`server exited before becoming ready (code ${code})`),
        );
      }
      // If server crashes after start, clear ready state
      if (started) {
        state.ready = false;
        sendProgress("error", "后端服务异常退出", `exit=${code}`);
      }
    });

    // 30s overall timeout
    setTimeout(async () => {
      if (healthPoll) clearInterval(healthPoll);
      if (!started) {
        if (await isServerRunning()) {
          started = true;
          state.serverProcess = proc;
          sendProgress("starting_server", "后端服务已启动 (端口探测)");
          resolve();
        } else {
          sendProgress(
            "error",
            "后端服务启动超时 (30s)",
            `输出: ${outputBuf.slice(-300)}`,
          );
          reject(new Error("Server failed to start within 30s"));
        }
      }
    }, 30_000);
  });
}

// ---- Auto-login ----

async function waitForServer(maxAttempts = 20): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    if (await isServerRunning()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Server did not become ready");
}

async function autoLogin(): Promise<string> {
  const base = `http://127.0.0.1:${SERVER_PORT}`;

  const sendRes = await fetch(`${base}/auth/send-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: AUTO_LOGIN_EMAIL }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!sendRes.ok) {
    const body = await sendRes.text().catch(() => "");
    throw new Error(`send-code failed: ${sendRes.status} ${body}`);
  }

  const verifyRes = await fetch(`${base}/auth/verify-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: AUTO_LOGIN_EMAIL, code: AUTO_LOGIN_CODE }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!verifyRes.ok) {
    const body = await verifyRes.text().catch(() => "");
    throw new Error(`verify-code failed: ${verifyRes.status} ${body}`);
  }
  const data = (await verifyRes.json()) as { token?: string };
  if (!data.token) throw new Error("verify-code response missing token");
  return data.token;
}

async function performAutoLogin(): Promise<void> {
  if (!state.ready) return;
  sendProgress("logging_in", "正在自动登录...");
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await waitForServer();
      const token = await autoLogin();
      const win = state.getMainWindow();
      if (win) {
        // IPC send is more reliable than executeJavaScript for token delivery
        win.webContents.send("auth:token", token);
        // Also writes to localStorage for the auth store hydration path
        win.webContents.executeJavaScript(
          `localStorage.setItem("multica_token", ${JSON.stringify(token)})`,
        );
      }
      sendProgress("logging_in", "登录成功");
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendProgress("logging_in", `登录重试 ${attempt}/3...`, msg);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  sendProgress("error", "自动登录失败", "请尝试重启应用");
}

// ---- Cleanup ----

async function stopGoServer(): Promise<void> {
  if (!state.serverProcess) return;
  const proc = state.serverProcess;
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      resolve();
    }, 5000);
    proc.on("close", () => {
      clearTimeout(timer);
      state.serverProcess = null;
      resolve();
    });
    proc.kill("SIGTERM");
  });
}

async function stopPostgres(): Promise<void> {
  if (!state.pgProcess) return;
  const proc = state.pgProcess;
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      resolve();
    }, 5000);
    proc.on("close", () => {
      clearTimeout(timer);
      state.pgProcess = null;
      resolve();
    });
    proc.kill("SIGTERM");
  });
}

export async function stopAllServers(): Promise<void> {
  await stopGoServer();
  await stopPostgres();
}

// ---- Main entry ----

let setupPromise: Promise<void> | null = null;

export async function setupServerManager(
  windowGetter: () => BrowserWindow | null,
): Promise<void> {
  // Register IPC handlers (safe to call multiple times — last registration wins)
  registerServerSettingsIPC();
  registerTemplateIPC();

  // Guard against concurrent calls
  if (state.starting) return setupPromise!;
  state.starting = true;

  setupPromise = (async () => {
    try {
      state.getMainWindow = windowGetter;

      // Check for reset-db flag
      const resetFlag = join(app.getPath("userData"), "reset-db.flag");
      if (existsSync(resetFlag)) {
        const ddir = dataDir();
        if (existsSync(ddir)) {
          sendProgress("init_pg", "正在重置数据库...");
          rmSync(ddir, { recursive: true, force: true });
        }
        rmSync(resetFlag, { force: true });
        sendProgress("init_pg", "数据库已重置，正在重新初始化...");
      }

      const binDir = pgsqlBinDir();
      const pgCtlPath = join(binDir, "pg_ctl.exe");

      sendProgress(
        "checking",
        "正在检查环境...",
        `exe路径: ${app.getAppPath()}`,
      );

      if (!existsSync(pgCtlPath)) {
        const parentExists = existsSync(join(binDir, ".."));
        const altPath = join(
          process.resourcesPath,
          "pgsql",
          "bin",
          "pg_ctl.exe",
        );
        const altExists = existsSync(altPath);
        sendProgress(
          "error",
          `缺少 pg_ctl.exe | asar:${parentExists ? "父目录在" : "父目录不在"} | extraRes:${altExists ? "在" : "不在"}`,
          `asar期望: ${pgCtlPath} ; extraRes: ${altPath}`,
        );
        return;
      }

      sendProgress("checking", "环境检查通过", `pg_ctl 已找到`);

      if (await isServerRunning()) {
        sendProgress("ready", "服务器已就绪");
        state.ready = true;
        await performAutoLogin();
        return;
      }

      if (!pgIsInitialized()) {
        const ddir = dataDir();
        if (existsSync(join(ddir, "PG_VERSION"))) {
          sendProgress("init_pg", "清理损坏的数据库目录...");
          rmSync(ddir, { recursive: true, force: true });
          mkdirSync(ddir, { recursive: true });
        }
        await initPostgres();
      }

      await startPostgres();
      await createDatabase();
      await runMigrations();
      await startGoServer();

      state.ready = true;
      sendProgress("ready", "全部就绪，正在进入...");

      await performAutoLogin();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendProgress("error", "启动失败", msg);
    } finally {
      state.starting = false;
    }
  })();

  return setupPromise;
}

// ---- Server preferences ----

export interface ServerPrefs {
  pgPort: number;
  serverPort: number;
  autoStart: boolean;
}

const DEFAULT_PREFS: ServerPrefs = { pgPort: PG_PORT, serverPort: SERVER_PORT, autoStart: true };
const PREFS_PATH = join(app.getPath("userData"), "server-prefs.json");

function loadServerPrefs(): ServerPrefs {
  try {
    const raw = readFileSync(PREFS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_PREFS, ...parsed };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function saveServerPrefs(prefs: ServerPrefs): void {
  writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2), "utf-8");
}

function registerServerSettingsIPC(): void {
  ipcMain.handle("server:get-prefs", () => loadServerPrefs());

  ipcMain.handle("server:set-prefs", (_e, partial: Partial<ServerPrefs>) => {
    const current = loadServerPrefs();
    const merged = { ...current, ...partial };
    saveServerPrefs(merged);
    return merged;
  });

  ipcMain.handle("server:reset-db", () => {
    const flagPath = join(app.getPath("userData"), "reset-db.flag");
    writeFileSync(flagPath, "reset-on-next-launch", "utf-8");
    return { success: true };
  });

  ipcMain.handle("server:export-db", async () => {
    const prefs = loadServerPrefs();
    const pgDump = join(pgsqlBinDir(), "pg_dump.exe");
    if (!existsSync(pgDump)) {
      throw new Error("pg_dump.exe not found — backup unavailable");
    }
    // pg_dump writes to stdout; we capture it
    return runCommand(pgDump, [
      "-h", "localhost",
      "-p", String(prefs.pgPort),
      "-U", PG_USER,
      "-d", PG_DB,
      "--no-password",
    ], {}, 60_000);
  });

  ipcMain.handle("server:import-db", async (_e, filePath: string) => {
    if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
    const prefs = loadServerPrefs();
    const psql = join(pgsqlBinDir(), "psql.exe");
    await runCommand(psql, [
      "-h", "localhost",
      "-p", String(prefs.pgPort),
      "-U", PG_USER,
      "-d", PG_DB,
      "-f", filePath,
    ], {}, 120_000);
    return { success: true };
  });
}

// ---- Agent template folder ----

const TEMPLATES_DIR = join(app.getPath("userData"), "agent-templates");

function ensureTemplatesDir(): string {
  mkdirSync(TEMPLATES_DIR, { recursive: true });
  return TEMPLATES_DIR;
}

function registerTemplateIPC(): void {
  const { shell } = require("electron");

  ipcMain.handle("templates:list", () => {
    const dir = ensureTemplatesDir();
    try {
      const files = readdirSync(dir).filter((f: string) => f.endsWith(".md"));
      return files.map((f: string) => {
        const content = readFileSync(join(dir, f), "utf-8");
        const nameMatch = content.match(/^---\nname:\s*(.+)$/m);
        const name = nameMatch?.[1]?.trim() ?? f.replace(/\.md$/, "");
        return { filename: f, name, path: join(dir, f) };
      });
    } catch {
      return [];
    }
  });

  ipcMain.handle("templates:read", (_e, filepath: string) => {
    try {
      return readFileSync(filepath, "utf-8");
    } catch {
      throw new Error(`Cannot read template: ${filepath}`);
    }
  });

  ipcMain.handle("templates:open-folder", () => {
    const dir = ensureTemplatesDir();
    shell.openPath(dir);
  });
}

export function getLatestProgress(): ServerProgress {
  return latestProgress;
}

export function isServerReady(): boolean {
  return state.ready;
}
