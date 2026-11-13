import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { threads } from "../runtime/sessions";
import { STRINGS } from "../runtime/strings";
import { uiError } from "../runtime/ui_error";
import { ARCHIVE_SETTINGS as S } from "../runtime/archive_settings_strings";
import {
  ARCHIVE_STRINGS,
  retryAutoArchive,
  useAutoArchive,
} from "../runtime/auto_archive";

const PRESETS = [0, 7, 30, 90];
type Owner = { alive: boolean; reading: boolean; saving: boolean };

/** Preference editing uses the existing persisted setting and archive admission. */
export function AutoArchiveSettings({
  onOpenArchived,
}: {
  onOpenArchived?: () => void;
}) {
  const [days, setDays] = useState<number | null>(null);
  const [custom, setCustom] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [readRevision, setReadRevision] = useState(0);
  const lifetime = useRef<Owner | null>(null);
  const autoArchive = useAutoArchive();

  useLayoutEffect(() => {
    const owner: Owner = { alive: true, reading: true, saving: false };
    lifetime.current = owner;
    return () => {
      owner.alive = false;
      if (lifetime.current === owner) lifetime.current = null;
    };
  }, []);

  useEffect(() => {
    const owner = lifetime.current;
    if (!owner) return;
    let cancelled = false;
    owner.reading = true;
    setLoading(true);
    setReadFailed(false);
    setError(null);
    void threads
      .readAutoArchiveDays()
      .then((saved) => {
        if (owner.alive && !cancelled) {
          setDays(saved);
          setCustom(false);
          setInput(String(saved || ""));
        }
      })
      .catch((reason) => {
        if (owner.alive && !cancelled) {
          setReadFailed(true);
          setError(uiError(reason, STRINGS.general.settingsLoadFailed));
        }
      })
      .finally(() => {
        if (owner.alive && !cancelled) {
          owner.reading = false;
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [readRevision]);

  const editable = () => {
    const owner = lifetime.current;
    return owner?.alive && !owner.reading && !owner.saving && days !== null
      ? owner
      : undefined;
  };

  const save = async (value: number, customValue: boolean) => {
    const owner = editable();
    if (!owner) return;
    owner.saving = true;
    setSaving(true);
    setError(null);
    try {
      await threads.setAutoArchiveDays(value);
      if (owner.alive) {
        setDays(value);
        setCustom(customValue);
        setInput(String(value || ""));
      }
    } catch (reason) {
      if (owner.alive)
        setError(uiError(reason, STRINGS.general.settingsSaveFailed));
    } finally {
      owner.saving = false;
      if (owner.alive) setSaving(false);
    }
  };

  const saveCustom = () => {
    if (!editable()) return;
    const value = input.trim();
    const parsed = Number(value);
    if (
      !/^\d+$/.test(value) ||
      !Number.isInteger(parsed) ||
      parsed < 1 ||
      parsed > 365
    ) {
      setError(S.invalid);
      return;
    }
    return save(parsed, true);
  };

  return (
    <section className="general-section" aria-labelledby="general-organization">
      <h2 id="general-organization" tabIndex={-1}>
        {STRINGS.general.organization}
      </h2>
      <div className="general-setting-row">
        <div>
          <strong>{STRINGS.general.autoArchive}</strong>
          <p>{ARCHIVE_STRINGS.description}</p>
        </div>
        <select
          aria-label={STRINGS.general.autoArchive}
          disabled={days === null || saving || loading}
          value={custom ? "custom" : (days ?? "")}
          onChange={(event) => {
            if (!editable()) return;
            const requested = event.target.value;
            if (requested === "custom") {
              setCustom(true);
              setError(null);
            } else if (PRESETS.includes(Number(requested))) {
              void save(Number(requested), false);
            }
          }}
        >
          {days === null && <option value="">{STRINGS.common.loading}</option>}
          {PRESETS.map((value) => (
            <option key={value} value={value}>
              {value === 0
                ? STRINGS.general.archiveOff
                : STRINGS.general.archiveAfter(value)}
            </option>
          ))}
          {days !== null && !PRESETS.includes(days) && (
            <option value={days}>{STRINGS.general.archiveAfter(days)}</option>
          )}
          <option value="custom">{S.custom}</option>
        </select>
      </div>
      {custom && (
        <form
          className="general-setting-row"
          onSubmit={(event) => {
            event.preventDefault();
            void saveCustom();
          }}
        >
          <div>
            <label htmlFor="auto-archive-custom-days">{S.days}</label>
            <p id="auto-archive-days-hint">{S.range}</p>
            {days !== null && <p>{S.current(days)}</p>}
          </div>
          <input
            id="auto-archive-custom-days"
            type="text"
            inputMode="numeric"
            size={5}
            aria-describedby="auto-archive-days-hint"
            aria-invalid={error === S.invalid}
            readOnly={saving || loading}
            value={input}
            onChange={(event) => {
              if (!editable()) return;
              setInput(event.target.value);
              setError(null);
            }}
          />
          <button
            type="submit"
            className="btn btn-secondary"
            aria-disabled={saving || loading}
          >
            {S.save}
          </button>
        </form>
      )}
      <details className="general-archive-rules">
        <summary>{ARCHIVE_STRINGS.rules}</summary>
        <ul>
          <li>{ARCHIVE_STRINGS.known}</li>
          <li>{ARCHIVE_STRINGS.protected}</li>
          <li>{ARCHIVE_STRINGS.restored}</li>
        </ul>
      </details>
      <div className="general-archive-actions">
        <p role={autoArchive.error ? "alert" : "status"}>
          {autoArchive.error ??
            (!autoArchive.ready || autoArchive.running
              ? ARCHIVE_STRINGS.checking
              : days === 0
                ? ARCHIVE_STRINGS.off
                : ARCHIVE_STRINGS.candidates(autoArchive.count))}
        </p>
        <button
          type="button"
          className="btn btn-text"
          disabled={autoArchive.running || !days}
          onClick={() => void retryAutoArchive()}
        >
          {ARCHIVE_STRINGS.retry}
        </button>
        {onOpenArchived && (
          <button
            type="button"
            className="btn btn-text"
            onClick={onOpenArchived}
          >
            {ARCHIVE_STRINGS.view}
          </button>
        )}
      </div>
      {saving && (
        <div className="general-feedback" role="status">
          {STRINGS.general.settingsSaving}
        </div>
      )}
      {error && (
        <div className="ac-error" role="alert">
          {error}
          {readFailed && (
            <button
              type="button"
              className="btn btn-text"
              disabled={saving || loading}
              onClick={() => {
                const owner = lifetime.current;
                if (!owner?.alive || owner.reading || owner.saving) return;
                owner.reading = true;
                setLoading(true);
                setReadRevision((value) => value + 1);
              }}
            >
              {STRINGS.common.retry}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
