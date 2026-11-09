export type Permission = NotificationPermission | "unsupported";

export const NOTIFY_ENABLED = import.meta.env.VITE_NOTIFY === "true";

export function notificationPermission(): Permission {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

/** Asks the browser once, from a click on the bell's "Notify me" control. */
export async function requestNotificationPermission(): Promise<Permission> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

/**
 * Shows the OS notification. The service worker path is what makes Android
 * Chrome and installed iOS work; `new Notification` is the desktop fallback.
 * Never throws: a failed OS notification leaves the in-app banner as the record.
 */
export async function showOsNotification(title: string, body: string, data?: Record<string, unknown>): Promise<boolean> {
  if (notificationPermission() !== "granted") return false;
  try {
    const container = navigator.serviceWorker;
    if (container) {
      const registration = await container.ready;
      await registration.showNotification(title, { body, tag: data?.key as string | undefined, data });
      return true;
    }
  } catch {
    // Fall through to the constructor.
  }
  try {
    new Notification(title, { body, tag: data?.key as string | undefined, data });
    return true;
  } catch {
    return false;
  }
}
