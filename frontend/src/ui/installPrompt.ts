import { h } from "./h";
import "../components/InstallPrompt.css";

/**
 * "Install app" control and the iOS home-screen hint (#85).
 *
 * Shown only when the browser actually offers an install:
 *  - Chrome/Edge/Android fire `beforeinstallprompt`; we keep the event and
 *    show the button, because calling prompt() outside that event is a
 *    no-op. The event does not fire at all on iOS, so iOS gets a one-line
 *    Share > Add to Home Screen hint instead.
 *  - Hidden when the app is already running standalone (installed), and
 *    remembered after a dismissal so it never nags.
 *
 * Mounted into `.app-shell`; the CSS hides it while a drawer or the
 * aircraft dossier is open so it cannot cover the thing the user is using.
 */

const INSTALL_DISMISSED_KEY = "flighttracker:pwaInstallDismissed";
const IOS_HINT_DISMISSED_KEY = "flighttracker:pwaIosHintDismissed";

interface InstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt(): Promise<void>;
}

function isStandalone(): boolean {
  if (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches) return true;
  // iOS Safari's own flag; display-mode is not reliable there in every version.
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** iOS Safari is the only iOS browser that can Add to Home Screen. */
function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  const iOS = /iphone|ipad|ipod/i.test(ua)
    // iPadOS 13+ reports a Macintosh UA; a touch-capable Mac is an iPad.
    || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  if (!iOS || !/applewebkit/i.test(ua)) return false;
  return !/crios|fxios|edgios|opios/i.test(ua);
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // private browsing / storage disabled: the banner still works, it just
    // will not be remembered. Best effort, like favorites.ts.
  }
}

export function mount(root: HTMLElement): () => void {
  if (isStandalone()) return () => {};

  let deferred: InstallPromptEvent | null = null;
  let el: HTMLElement | null = null;

  const remove = (): void => {
    el?.remove();
    el = null;
  };

  const dismiss = (key: string): void => {
    writeFlag(key);
    remove();
  };

  const render = (kind: "install" | "ios"): void => {
    remove();
    if (isStandalone()) return;
    if (kind === "install" && !deferred) return;
    if (kind === "install" && readFlag(INSTALL_DISMISSED_KEY)) return;
    if (kind === "ios" && readFlag(IOS_HINT_DISMISSED_KEY)) return;

    const text = kind === "install"
      ? "Install Netwatch Skygrid for a full-screen app."
      : "Install on iPhone: tap Share, then “Add to Home Screen”.";

    const dismissKey = kind === "install" ? INSTALL_DISMISSED_KEY : IOS_HINT_DISMISSED_KEY;
    const action = kind === "install"
      ? h("button", {
          type: "button",
          className: "install-banner-action",
          onClick: async () => {
            if (!deferred) return;
            const event = deferred;
            deferred = null;
            remove();
            try {
              await event.prompt();
              await event.userChoice;
            } catch {
              // The prompt can only be called once; a rejection here just
              // means the browser changed its mind. Stay silent.
            }
          },
        }, "Install app")
      : null;

    el = h(
      "div",
      { className: "install-banner", role: "status", "aria-live": "polite" },
      h("span", { className: "install-banner-text" }, text),
      action,
      h(
        "button",
        {
          type: "button",
          className: "install-banner-dismiss",
          "aria-label": "Not now",
          title: "Not now",
          onClick: () => dismiss(dismissKey),
        },
        "×",
      ),
    );
    root.appendChild(el);
  };

  const onBeforeInstall = (event: Event): void => {
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    render("install");
  };
  const onInstalled = (): void => remove();
  const onDisplayMode = (): void => {
    if (isStandalone()) remove();
  };
  const media = typeof matchMedia === "function" ? matchMedia("(display-mode: standalone)") : null;
  const onMedia = (): void => {
    if (media?.matches) remove();
  };

  window.addEventListener("beforeinstallprompt", onBeforeInstall);
  window.addEventListener("appinstalled", onInstalled);
  if (media) {
    if (typeof media.addEventListener === "function") media.addEventListener("change", onMedia);
    else media.addListener(onMedia); // Safari < 14
  }

  // iOS has no install event at all, so the hint is offered on first load
  // (unless already installed or dismissed).
  if (isIosSafari()) render("ios");

  return () => {
    window.removeEventListener("beforeinstallprompt", onBeforeInstall);
    window.removeEventListener("appinstalled", onInstalled);
    if (media) {
      if (typeof media.removeEventListener === "function") media.removeEventListener("change", onMedia);
      else media.removeListener(onMedia);
    }
    remove();
  };
}
