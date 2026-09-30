import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { STRINGS } from "./strings";
import { uiError } from "./ui_error";

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export interface ThemeStatus {
  ready: boolean;
  saving: boolean;
  error: string | null;
  retry: () => void;
}

const legacyThemeKey = "farfold.theme-mode";
const darkSchemeQuery = "(prefers-color-scheme: dark)";
type LegacyStorage = Pick<Storage, "getItem" | "removeItem">;

export function parseThemeMode(value: unknown): ThemeMode {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : "light";
}

export function resolveTheme(
  mode: ThemeMode,
  systemPrefersDark: boolean,
): ResolvedTheme {
  return mode === "system" ? (systemPrefersDark ? "dark" : "light") : mode;
}

function removeLegacy(storage?: LegacyStorage): void {
  try {
    storage?.removeItem(legacyThemeKey);
  } catch {
    // Metadata is already authoritative; a stale key is never read again.
  }
}

let loading: Promise<ThemeMode> | null = null;

export function loadThemePreference(
  storage?: LegacyStorage,
): Promise<ThemeMode> {
  // StrictMode and remounts can request initialization twice. Share the migration
  // itself so an abandoned read cannot later overwrite a user's saved choice.
  loading ??= readThemePreference(storage).finally(() => {
    loading = null;
  });
  return loading;
}

async function readThemePreference(
  storage?: LegacyStorage,
): Promise<ThemeMode> {
  const saved = await invoke<unknown>("settings_get", { key: "themeMode" });
  if (saved !== null && saved !== undefined) {
    removeLegacy(storage);
    return parseThemeMode(saved);
  }
  let legacy: string | null | undefined;
  try {
    legacy = storage?.getItem(legacyThemeKey);
  } catch {
    /* Old storage may be disabled. */
  }
  const mode = parseThemeMode(legacy);
  if (legacy !== null && legacy !== undefined) {
    await saveThemePreference(mode);
    removeLegacy(storage);
  }
  return mode;
}

export async function saveThemePreference(mode: ThemeMode): Promise<void> {
  await invoke("settings_set", { key: "themeMode", value: mode });
}

export function useThemePreference(): [
  ThemeMode,
  (mode: ThemeMode) => void,
  ThemeStatus,
] {
  const [mode, setMode] = useState<ThemeMode>("light");
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const inFlight = useRef(false);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setReady(false);
    let storage: LegacyStorage | undefined;
    try {
      storage = window.localStorage;
    } catch {
      /* Metadata remains available. */
    }
    void loadThemePreference(storage)
      .then((value) => {
        if (!cancelled) {
          setMode(value);
          setReady(true);
        }
      })
      .catch((reason) => {
        if (!cancelled)
          setError(uiError(reason, STRINGS.general.settingsLoadFailed));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const save = useCallback(
    (value: ThemeMode) => {
      if (!ready || inFlight.current) return;
      inFlight.current = true;
      setSaving(true);
      setError(null);
      void saveThemePreference(value)
        .then(() => setMode(value))
        .catch((reason) => {
          setError(uiError(reason, STRINGS.general.settingsSaveFailed));
        })
        .finally(() => {
          inFlight.current = false;
          setSaving(false);
        });
    },
    [ready],
  );

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
    return () => media.removeEventListener("change", apply);
  }, [mode]);

  return [
    mode,
    save,
    { ready, saving, error, retry: () => setAttempt((n) => n + 1) },
  ];
}
