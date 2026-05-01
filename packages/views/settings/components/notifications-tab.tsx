"use client";

import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { notificationPreferenceOptions } from "@multica/core/notification-preferences/queries";
import { useUpdateNotificationPreferences } from "@multica/core/notification-preferences/mutations";
import type { NotificationGroupKey, NotificationPreferences } from "@multica/core/types";
import { Card, CardContent } from "@multica/ui/components/ui/card";
import { Switch } from "@multica/ui/components/ui/switch";
import { toast } from "sonner";
import { useAppLocale } from "@multica/i18n";

export function NotificationsTab() {
  const wsId = useWorkspaceId();
  const { t } = useAppLocale();

  const notificationGroups: {
    key: NotificationGroupKey;
    label: string;
    description: string;
  }[] = [
    {
      key: "assignments",
      label: t.settings.notificationGroups.assignments.label,
      description: t.settings.notificationGroups.assignments.description,
    },
    {
      key: "status_changes",
      label: t.settings.notificationGroups.statusChanges.label,
      description: t.settings.notificationGroups.statusChanges.description,
    },
    {
      key: "comments",
      label: t.settings.notificationGroups.comments.label,
      description: t.settings.notificationGroups.comments.description,
    },
    {
      key: "updates",
      label: t.settings.notificationGroups.updates.label,
      description: t.settings.notificationGroups.updates.description,
    },
    {
      key: "agent_activity",
      label: t.settings.notificationGroups.agentActivity.label,
      description: t.settings.notificationGroups.agentActivity.description,
    },
  ];
  const { data } = useQuery(notificationPreferenceOptions(wsId));
  const mutation = useUpdateNotificationPreferences();

  const preferences = data?.preferences ?? {};

  const handleToggle = (key: NotificationGroupKey, enabled: boolean) => {
    const updated: NotificationPreferences = {
      ...preferences,
      [key]: enabled ? "all" : "muted",
    };
    // Remove keys set to "all" (default) to keep the object clean
    if (enabled) {
      delete updated[key];
    }
    mutation.mutate(updated, {
      onError: () => toast.error(t.settings.notificationUpdateFailed),
    });
  };

  return (
    <div className="space-y-4">
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold">{t.settings.inboxNotifications}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {t.settings.inboxNotificationsDescription}
          </p>
        </div>

        <Card>
          <CardContent className="divide-y">
            {notificationGroups.map((group) => {
              const enabled = preferences[group.key] !== "muted";
              return (
                <div
                  key={group.key}
                  className="flex items-center justify-between py-3 first:pt-0 last:pb-0"
                >
                  <div className="space-y-0.5 pr-4">
                    <p className="text-sm font-medium">{group.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {group.description}
                    </p>
                  </div>
                  <Switch
                    checked={enabled}
                    onCheckedChange={(checked) =>
                      handleToggle(group.key, checked)
                    }
                  />
                </div>
              );
            })}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
