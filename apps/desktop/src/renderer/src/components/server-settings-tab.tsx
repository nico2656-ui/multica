import { useState, useEffect, useCallback, type ReactNode } from "react";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Switch } from "@multica/ui/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multica/ui/components/ui/alert-dialog";
import { toast } from "sonner";
import { Database, RotateCcw, Download, Upload } from "lucide-react";

export interface ServerPrefs {
  pgPort: number;
  serverPort: number;
  autoStart: boolean;
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function ServerSettingsTab() {
  const [prefs, setPrefs] = useState<ServerPrefs>({
    pgPort: 15432,
    serverPort: 8080,
    autoStart: true,
  });
  const [saving, setSaving] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  useEffect(() => {
    window.serverSettings.getPrefs().then(setPrefs);
  }, []);

  const handleSetPrefs = useCallback(
    async (partial: Partial<ServerPrefs>) => {
      setSaving(true);
      try {
        const updated = await window.serverSettings.setPrefs(partial);
        setPrefs(updated);
        toast.success("设置已保存，重启后生效");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "保存失败");
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  const handleExport = useCallback(async () => {
    try {
      const sql = await window.serverSettings.exportDb();
      const blob = new Blob([sql], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      a.href = url;
      a.download = `multica-backup-${ts}.sql`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("数据库已导出");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "导出失败");
    }
  }, []);

  const handleImport = useCallback(async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".sql";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        await window.serverSettings.importDb((file as any).path);
        toast.success("数据库已导入，请重启应用");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "导入失败");
      }
    };
    input.click();
  }, []);

  const handleResetDb = useCallback(async () => {
    try {
      await window.serverSettings.resetDatabase();
      toast.success("数据库将在下次启动时重建");
      setResetOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "重置失败");
    }
  }, []);

  return (
    <div>
      <h2 className="text-lg font-semibold">嵌入服务器</h2>
      <p className="text-sm text-muted-foreground mt-1">
        管理内嵌 PostgreSQL 和 Go 后端的端口配置。修改后需重启应用。
      </p>

      <div className="mt-6 divide-y">
        <SettingRow
          label="PostgreSQL 端口"
          description={`当前运行在端口 ${prefs.pgPort}。修改后重启生效。`}
        >
          <Input
            type="number"
            value={prefs.pgPort}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (v > 0 && v < 65536) setPrefs((p) => ({ ...p, pgPort: v }));
            }}
            className="w-20"
            disabled={saving}
          />
        </SettingRow>

        <SettingRow
          label="后端 API 端口"
          description={`当前运行在端口 ${prefs.serverPort}。前端和 daemon 通过此端口通信。`}
        >
          <Input
            type="number"
            value={prefs.serverPort}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (v > 0 && v < 65536) setPrefs((p) => ({ ...p, serverPort: v }));
            }}
            className="w-20"
            disabled={saving}
          />
        </SettingRow>

        <SettingRow
          label="开机自动启动服务器"
          description="应用启动时自动拉起 PostgreSQL 和 Go 后端。"
        >
          <Switch
            checked={prefs.autoStart}
            onCheckedChange={(checked) => handleSetPrefs({ ...prefs, autoStart: checked })}
            disabled={saving}
          />
        </SettingRow>

        <div className="py-4">
          <Button
            variant="default"
            onClick={() => handleSetPrefs(prefs)}
            disabled={saving}
          >
            {saving ? "保存中..." : "保存并应用"}
          </Button>
          <span className="ml-2 text-xs text-muted-foreground">
            修改端口后需要重启应用
          </span>
        </div>
      </div>

      {/* Backup & restore */}
      <div className="mt-8">
        <h3 className="text-sm font-semibold">备份与恢复</h3>
        <div className="mt-3 rounded-lg border bg-muted/20 px-4 py-3 flex gap-3">
          <Button variant="outline" size="sm" onClick={handleExport}>
            <Download className="mr-1 h-3 w-3" />
            导出数据库
          </Button>
          <Button variant="outline" size="sm" onClick={handleImport}>
            <Upload className="mr-1 h-3 w-3" />
            导入数据库
          </Button>
        </div>
      </div>

      {/* Reset database */}
      <div className="mt-8">
        <h3 className="text-sm font-semibold text-red-600">危险操作</h3>
        <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3">
          <div className="flex items-start gap-3">
            <Database className="h-4 w-4 mt-0.5 text-red-500" />
            <div className="flex-1">
              <p className="text-sm font-medium">重置数据库</p>
              <p className="text-xs text-muted-foreground mt-1">
                删除所有数据并重建空白数据库。此操作不可撤销。
              </p>
              <Button
                variant="destructive"
                size="sm"
                className="mt-2"
                onClick={() => setResetOpen(true)}
              >
                <RotateCcw className="mr-1 h-3 w-3" />
                重置数据库
              </Button>
            </div>
          </div>
        </div>
      </div>

      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认重置数据库？</AlertDialogTitle>
            <AlertDialogDescription>
              所有 Issue、Agent、工作区、设置等数据将被永久删除。数据库将在下次启动时重新创建。此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleResetDb}>
              确认重置
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
