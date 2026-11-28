// uPlot runs `new Intl.NumberFormat(navigator.language)` when it is imported. A POSIX
// locale such as "en-US@posix" (Chromium on Linux with LANG unset or LANG=C) makes that
// throw, and the whole UI renders blank. Fall back to en-US, the locale every formatter
// here uses anyway. main.tsx imports this module first, before anything imports uPlot.
export const guardLocale = (nav: { language: string } = navigator): void => {
  try {
    new Intl.NumberFormat(nav.language);
  } catch {
    Object.defineProperty(nav, "language", { value: "en-US", configurable: true });
  }
};

guardLocale();
