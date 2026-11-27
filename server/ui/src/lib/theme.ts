import { useSyncExternalStore } from "react";

export type Theme = "dark" | "light";

const KEY = "grad-theme";
const listeners = new Set<() => void>();

/** The saved theme; dark unless this browser chose light (storage may be unavailable). */
export const savedTheme = (): Theme => {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
};

let current: Theme = savedTheme();

/** Sets `<html data-theme>`, which the tokens in styles/tokens.css key off. */
export const applyTheme = (theme: Theme): void => {
  current = theme;
  document.documentElement.dataset.theme = theme;
  listeners.forEach((l) => l());
};

export const setTheme = (theme: Theme): void => {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Private windows may refuse storage: the choice then lasts for this page only.
  }
  applyTheme(theme);
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useTheme = (): Theme => useSyncExternalStore(subscribe, () => current);
