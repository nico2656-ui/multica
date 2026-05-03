import { execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

function hasGo() {
  try {
    execSync("go version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

if (!hasGo()) {
  console.log("[bundle-server] `go` not found in PATH — skipping Go build.");
  console.log("[bundle-server] Desktop will use prebuilt binaries in resources/bin/.");
  process.exit(0);
}

const root = resolve(import.meta.dirname, "../../..");
const serverDir = join(root, "server");
const binDir = join(root, "apps/desktop/resources/bin");
const migrateEmbedDir = join(serverDir, "cmd/migrate-embed");
const migrationsDir = join(serverDir, "migrations");

// Ensure output directory exists
mkdirSync(binDir, { recursive: true });

// --- Build migrate-embed (with embedded SQL) ---
// Copy migrations into cmd/migrate-embed so go:embed can find them.
const embeddedMigrations = join(migrateEmbedDir, "migrations");
console.log("[bundle-server] Copying migrations for embed...");
cpSync(migrationsDir, embeddedMigrations, { recursive: true });

try {
  console.log("[bundle-server] Building migrate-embed...");
  execSync(
    `go build -o ${JSON.stringify(join(binDir, "migrate.exe"))} ./cmd/migrate-embed/`,
    { cwd: serverDir, stdio: "inherit", env: { ...process.env, CGO_ENABLED: "0", GOOS: "windows", GOARCH: "amd64" } },
  );
} finally {
  // Clean up copied migrations
  rmSync(embeddedMigrations, { recursive: true, force: true });
}

// --- Build server ---
console.log("[bundle-server] Building server...");
execSync(
  `go build -o ${JSON.stringify(join(binDir, "server.exe"))} ./cmd/server/`,
  { cwd: serverDir, stdio: "inherit", env: { ...process.env, CGO_ENABLED: "0", GOOS: "windows", GOARCH: "amd64" } },
);

console.log("[bundle-server] Done. Binaries in", binDir);
