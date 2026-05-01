import type { IssueStatus } from "@multica/core/types";
import { useAppLocale } from "@multica/i18n";
import { StatusIcon } from "./status-icon";

export function StatusHeading({
  status,
  count,
}: {
  status: IssueStatus;
  count: number;
}) {
  const { t } = useAppLocale();
  return (
    <div className="flex items-center gap-2">
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold">
        <StatusIcon status={status} className="h-3 w-3" />
        {t.issues.statusLabels[status]}
      </span>
      <span className="text-xs text-muted-foreground">{count}</span>
    </div>
  );
}
