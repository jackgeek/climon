export type PwaPlatform = "ios" | "android" | "other";

export function detectPwaPlatform(userAgent: string): PwaPlatform {
  const ua = userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return "ios";
  if (ua.includes("android")) return "android";
  return "other";
}

export function pwaInstallInstructions(platform: PwaPlatform): string {
  switch (platform) {
    case "ios":
      return 'Tap the Share button, then choose "Add to Home Screen" to install climon. Open it from the new icon to receive notifications.';
    case "android":
      return "Tap Install to add climon to your home screen. Open it from the new icon to receive notifications.";
    case "other":
      return "Use your browser's install option (usually in the address bar or menu) to install climon as an app.";
  }
}
