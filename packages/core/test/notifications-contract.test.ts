import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function source(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

describe("notification product boundary", () => {
  it("keeps free local thresholds in the desktop process", () => {
    const rust = source("apps/desktop/src-tauri/src/notifications.rs");
    const app = source("apps/desktop/ui/app.js");
    expect(rust).toContain("const THRESHOLDS: [u32; 3] = [60, 80, 90]");
    expect(rust).toContain("tauri_plugin_notification::NotificationExt");
    expect(app).toContain("evaluateNotifications(notificationSamples)");
    expect(app).toContain("renderNotificationEvents");
  });

  it("keeps remote controls behind the Pro function and the bell", () => {
    const bell = source("apps/web/app/app/notification-bell.tsx");
    const client = source("apps/web/lib/pro-notifications.ts");
    expect(bell).toContain("NotificationBell");
    expect(bell).toContain("Quiet hours");
    expect(bell).toContain("Daily digest");
    expect(client).toContain('functions.invoke<T>("pro-service"');
  });

  it("receives push only through the application service worker", () => {
    const worker = source("apps/web/public/sw.js");
    expect(worker).toContain('self.addEventListener("push"');
    expect(worker).toContain('self.addEventListener("notificationclick"');
    expect(worker).toContain('showNotification(title');
  });
});
