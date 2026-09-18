import { useEffect, useState } from "react";

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const themeStorageKey = "farfold.theme-mode";
const darkSchemeQuery = "(prefers-color-scheme: dark)";

export function parseThemeMode(value: string | null): ThemeMode {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : "light";
}

export function resolveTheme(
  mode: ThemeMode,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (mode === "system") return systemPrefersDark ? "dark" : "light";
  return mode;
}

function storedThemeMode(): ThemeMode {
  if (typeof window === "undefined") return "light";
  try {
    return parseThemeMode(window.localStorage.getItem(themeStorageKey));
  } catch {
    return "light";
  }
}

export function useThemePreference(): [ThemeMode, (mode: ThemeMode) => void] {
  const [mode, setMode] = useState<ThemeMode>(storedThemeMode);

  useEffect(() => {
    const media = window.matchMedia(darkSchemeQuery);
    const apply = () => {
      document.documentElement.dataset.themeMode = mode;
      document.documentElement.dataset.theme = resolveTheme(
        mode,
        media.matches,
      );
    };
    apply();
    if (mode === "system") media.addEventListener("change", apply);
    try {
      window.localStorage.setItem(themeStorageKey, mode);
    } catch {
      // Theme still applies for this launch when storage is unavailable.
    }
    return () => media.removeEventListener("change", apply);
  }, [mode]);

  return [mode, setMode];
}
