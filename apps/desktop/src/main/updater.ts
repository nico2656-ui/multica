// Auto-update is disabled for self-hosted builds.
// All update checks, downloads, and GitHub release polling are no-ops.

import { BrowserWindow } from "electron";

export type ManualUpdateCheckResult =
  | {
      ok: true;
      currentVersion: string;
      latestVersion: string;
      available: boolean;
    }
  | { ok: false; error: string };

export function setupAutoUpdater(_getMainWindow: () => BrowserWindow | null): void {
  // No-op — auto-update disabled for self-hosted build.
}
