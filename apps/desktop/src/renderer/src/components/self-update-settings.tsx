import { useState, useEffect, useCallback } from "react";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { RefreshCw, CheckCircle2, AlertCircle } from "lucide-react";
import { cn } from "@multica/ui/lib/utils";

export function SelfUpdateSettings() {
  const [repoPath, setRepoPath] = useState("");
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState("");

  // Load saved path on mount
  useEffect(() => {
    window.selfUpdate.getRepoPath().then((r) => {
      if (r.path) {
        setRepoPath(r.path);
        setSavedPath(r.path);
      }
    });
  }, []);

  const handleSavePath = useCallback(async () => {
    const trimmed = repoPath.trim().replace(/\\/g, "/");
    if (!trimmed) return;
    const result = await window.selfUpdate.setRepoPath(trimmed);
    if (result.success) {
      setSavedPath(trimmed);
      setError(null);
    } else {
      setError(result.error || "路径无效");
    }
  }, [repoPath]);

  const handleRebuild = async () => {
    if (!savedPath) {
      setError("请先配置项目仓库路径");
      return;
    }
    setBuilding(true);
    setDone(false);
    setError(null);
    setStatusMsg("");

    try {
      // Listen for progress
      const unsub = window.desktopAPI.onServerProgress((p) => {
        if (p.message.startsWith("[更新]")) {
          const msg = p.message.replace("[更新] ", "");
          setStatusMsg(msg);
          if (msg.includes("已就绪")) setDone(true);
          if (msg.startsWith("更新失败")) setError(msg.replace("更新失败: ", ""));
        }
      });

      const result = await window.selfUpdate.rebuild();
      unsub();
      if (!result.success) {
        setError(result.error || "未知错误");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新失败");
    } finally {
      setBuilding(false);
    }
  };

  const handleRestart = () => {
    window.selfUpdate.restart();
  };

  return (
    <div className="space-y-4">
      {/* Path config */}
      <div>
        <p className="mb-2 text-sm font-medium">项目仓库路径</p>
        <div className="flex gap-2">
          <Input
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            placeholder="C:\Users\10584\Documents\GitHub\multica"
            className="flex-1"
          />
          <Button onClick={handleSavePath} variant="outline" size="sm">
            保存
          </Button>
        </div>
        {savedPath && (
          <p className="mt-1 text-xs text-green-600">
            ✓ 已配置: {savedPath}
          </p>
        )}
        {error && !building && !done && (
          <p className="mt-1 text-xs text-red-500">{error}</p>
        )}
      </div>

      {/* Rebuild button */}
      <Button
        onClick={handleRebuild}
        disabled={building || !savedPath}
        className="w-full"
      >
        <RefreshCw className={cn("mr-2 h-4 w-4", building && "animate-spin")} />
        {building ? "编译中..." : "拉取代码并重新编译"}
      </Button>

      {/* Status */}
      {statusMsg && (
        <div
          className={cn(
            "flex items-center gap-2 rounded-md border p-3 text-sm",
            done && "border-green-500/30 bg-green-500/5 text-green-600",
            error && "border-red-500/30 bg-red-500/5 text-red-600",
            !done && !error && "border-muted bg-muted/20 text-muted-foreground",
          )}
        >
          {done ? (
            <CheckCircle2 className="h-4 w-4 shrink-0" />
          ) : error ? (
            <AlertCircle className="h-4 w-4 shrink-0" />
          ) : (
            <RefreshCw className="h-4 w-4 shrink-0 animate-spin" />
          )}
          <span className="flex-1">{statusMsg}</span>
        </div>
      )}

      {/* Restart */}
      {done && (
        <Button onClick={handleRestart} className="w-full">
          重启应用以应用更新
        </Button>
      )}

      <div className="text-xs text-muted-foreground space-y-1">
        <p>数据目录（不受更新影响）：<code>%APPDATA%\@multica\desktop\</code></p>
        <p>程序目录：<code>%LOCALAPPDATA%\Programs\@multicadesktop\</code></p>
        <p className="mt-2">
          如需手动更新：<code>cd 项目目录 && git pull && node apps/desktop/scripts/patch-installed.mjs</code>
        </p>
      </div>
    </div>
  );
}
