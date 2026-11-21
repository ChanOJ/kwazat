"use client";

/**
 * Red lines editor. Rules are decrypted and encrypted here, in the browser; the server only
 * receives ciphertext (docs/design/red-lines.md, section 0, Q6).
 */
import { OFFENSE_CLASSES, vault, type OffenseClass, type StoredRedLine, type Vault } from "@kwazat/redlines";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import type { StoredRedLines } from "@/lib/red-lines.ts";
import { deleteRedLines, findEntitiesForRule, loadRedLines, saveRedLines, type EntityOption } from "./actions.ts";
import { deleteDeviceKey, getDeviceKey, putDeviceKey } from "./device-key.ts";

type Ready = { vault: Vault; dataKey: CryptoKey; wraps: StoredRedLines["keyWraps"]; revision: number };
type State =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "locked" }
  | { kind: "ready"; data: Ready }
  | { kind: "failed" };

async function unlock(userId: string, stored: StoredRedLines | null): Promise<State> {
  if (!stored) return { kind: "empty" };
  const device = await getDeviceKey(userId);
  const wrap = device && stored.keyWraps.find((w) => w.id === device.wrapId);
  if (!device || !wrap) return { kind: "locked" };
  const dataKey = await vault.unwrapDataKey(wrap, device.key, userId);
  const opened = await vault.open(stored, dataKey, userId);
  return { kind: "ready", data: { vault: opened, dataKey, wraps: stored.keyWraps, revision: stored.revision } };
}

export function RedLinesEditor({ userId, stored }: { userId: string; stored: StoredRedLines | null }) {
  const t = useTranslations("redLinesSettings");
  const [state, setState] = useState<State>({ kind: "loading" });
  const [message, setMessage] = useState<{ error?: string; ok?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    unlock(userId, stored).then(setState, () => setState({ kind: "failed" }));
  }, [userId, stored]);

  /** Encrypts and stores new rules. The first save creates the keys and records consent. */
  const commit = useCallback(
    async (rules: StoredRedLine[], consentAt?: string) => {
      setBusy(true);
      setMessage(null);
      try {
        if (state.kind === "ready") {
          const next: Vault = { ...state.data.vault, rules };
          const sealed = await vault.seal(next, state.data.dataKey, userId);
          const result = await saveRedLines({ ...sealed, keyWraps: state.data.wraps, expectedRevision: state.data.revision });
          if (result.ok) {
            setState({ kind: "ready", data: { ...state.data, vault: next, revision: result.revision } });
          } else if (result.error === "conflict") {
            setState(await unlock(userId, await loadRedLines()));
            setMessage({ error: "conflict" });
          } else {
            setMessage({ error: "saveFailed" });
          }
          return;
        }
        // First save on this account: new data key and device key.
        const dataKey = await vault.newDataKey();
        const deviceKey = await vault.newDeviceKey();
        const wrapId = vault.newWrapId();
        const wrap = await vault.wrapDataKey(dataKey, deviceKey, userId, wrapId, new Date());
        const next: Vault = { version: 1, consentAt: consentAt ?? new Date().toISOString(), rules };
        const sealed = await vault.seal(next, dataKey, userId);
        await putDeviceKey(userId, { wrapId, key: deviceKey });
        const result = await saveRedLines({ ...sealed, keyWraps: [wrap], expectedRevision: null });
        if (result.ok) {
          setState({ kind: "ready", data: { vault: next, dataKey, wraps: [wrap], revision: result.revision } });
        } else {
          await deleteDeviceKey(userId);
          setState(await unlock(userId, await loadRedLines()));
          setMessage({ error: result.error === "conflict" ? "conflict" : "saveFailed" });
        }
      } catch {
        setMessage({ error: "saveFailed" });
      } finally {
        setBusy(false);
      }
    },
    [state, userId],
  );

  const deleteAll = useCallback(async () => {
    if (!window.confirm(t("deleteAllConfirm"))) return;
    setBusy(true);
    await deleteRedLines();
    await deleteDeviceKey(userId).catch(() => undefined);
    setBusy(false);
    setState({ kind: "empty" });
    setMessage({ ok: "deletedAll" });
  }, [t, userId]);

  if (state.kind === "loading") return <p aria-busy="true">{t("loading")}</p>;
  if (state.kind === "failed") return <p className="error" role="alert">{t("unlockFailed")}</p>;

  return (
    <>
      {message?.error && <p className="error" role="alert">{t(message.error as never)}</p>}
      {message?.ok && <p className="notice" role="status">{t(message.ok as never)}</p>}
      {state.kind === "locked" && (
        <section className="panel">
          <h2>{t("lockedTitle")}</h2>
          <p>{t("lockedBody")}</p>
          <button type="button" className="danger" onClick={deleteAll} disabled={busy}>
            {t("startOver")}
          </button>
        </section>
      )}
      {state.kind === "empty" && <Consent onAccept={(at) => commit([], at)} busy={busy} />}
      {state.kind === "ready" && (
        <>
          <RuleList rules={state.data.vault.rules} onChange={commit} busy={busy} />
          <AddRule onAdd={(rule) => commit([...state.data.vault.rules, rule])} busy={busy} />
          <section className="panel">
            <h2>{t("dataTitle")}</h2>
            <p>{t("dataBody")}</p>
            <p className="actions">
              <button type="button" onClick={() => exportVault(state.data.vault)}>
                {t("export")}
              </button>
              <button type="button" className="danger" onClick={deleteAll} disabled={busy}>
                {t("deleteAll")}
              </button>
            </p>
          </section>
        </>
      )}
    </>
  );
}

function Consent({ onAccept, busy }: { onAccept: (at: string) => void; busy: boolean }) {
  const t = useTranslations("redLinesSettings");
  const [checked, setChecked] = useState(false);
  return (
    <section className="panel">
      <h2>{t("consentTitle")}</h2>
      <ul>
        <li>{t("consentSensitive")}</li>
        <li>{t("consentEncrypted")}</li>
        <li>{t("consentDevice")}</li>
        <li>{t("consentRights")}</li>
      </ul>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (checked) onAccept(new Date().toISOString());
        }}
      >
        <label className="check">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} required />
          {t("consentCheckbox")}
        </label>
        <button type="submit" disabled={!checked || busy}>
          {t("consentButton")}
        </button>
      </form>
    </section>
  );
}

function describe(rule: StoredRedLine, t: ReturnType<typeof useTranslations<"redLinesSettings">>): string {
  switch (rule.kind) {
    case "entity":
      return t(rule.includeIndirect ? "ruleEntityIndirect" : "ruleEntityDirect", { label: rule.label });
    case "conviction":
      return t("ruleConviction", { class: t(`offense.${rule.minOffenseClass}`) });
    case "proceedings":
      return t("ruleProceedings");
  }
}

function RuleList({ rules, onChange, busy }: { rules: StoredRedLine[]; onChange: (rules: StoredRedLine[]) => void; busy: boolean }) {
  const t = useTranslations("redLinesSettings");
  return (
    <section className="panel">
      <h2>{t("listTitle")}</h2>
      {rules.length === 0 ? (
        <p>{t("listEmpty")}</p>
      ) : (
        <ul className="red-lines">
          {rules.map((rule) => (
            <li key={rule.id} className={rule.enabled ? undefined : "disabled"}>
              <span>{describe(rule, t)}</span>
              <span className="actions">
                <button
                  type="button"
                  className="button-link"
                  disabled={busy}
                  onClick={() => onChange(rules.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r)))}
                >
                  {rule.enabled ? t("disable") : t("enable")}
                </button>
                <button type="button" className="button-link" disabled={busy} onClick={() => onChange(rules.filter((r) => r.id !== rule.id))}>
                  {t("remove")}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type Kind = StoredRedLine["kind"];

function AddRule({ onAdd, busy }: { onAdd: (rule: StoredRedLine) => void; busy: boolean }) {
  const t = useTranslations("redLinesSettings");
  const [kind, setKind] = useState<Kind>("entity");
  const [entity, setEntity] = useState<EntityOption | null>(null);
  const [indirect, setIndirect] = useState(true);
  const [minClass, setMinClass] = useState<OffenseClass>("misdemeanor");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const base = { id: crypto.randomUUID(), enabled: true, createdAt: new Date().toISOString() };
    if (kind === "entity") {
      if (!entity) return;
      onAdd({ ...base, kind, entityId: entity.entityId, wikidataId: entity.wikidataId, label: entity.label, includeIndirect: indirect });
      setEntity(null);
    } else if (kind === "conviction") {
      onAdd({ ...base, kind, minOffenseClass: minClass });
    } else {
      onAdd({ ...base, kind });
    }
  };

  return (
    <section className="panel">
      <h2>{t("addTitle")}</h2>
      <form className="stack" onSubmit={submit}>
        <fieldset>
          <legend>{t("kindLegend")}</legend>
          {(["entity", "conviction", "proceedings"] as const).map((k) => (
            <label key={k} className="check">
              <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
              {t(`kind.${k}`)}
            </label>
          ))}
        </fieldset>
        {kind === "entity" && (
          <>
            <EntityPicker value={entity} onChange={setEntity} />
            <label className="check">
              <input type="checkbox" checked={indirect} onChange={(e) => setIndirect(e.target.checked)} />
              {t("includeIndirect")}
            </label>
          </>
        )}
        {kind === "conviction" && (
          <label>
            {t("minClass")}
            <select value={minClass} onChange={(e) => setMinClass(e.target.value as OffenseClass)}>
              {OFFENSE_CLASSES.map((c) => (
                <option key={c} value={c}>
                  {t(`offense.${c}`)}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="hint">{t(`kindHint.${kind}`)}</p>
        <button type="submit" disabled={busy || (kind === "entity" && !entity)}>
          {t("add")}
        </button>
      </form>
    </section>
  );
}

function EntityPicker({ value, onChange }: { value: EntityOption | null; onChange: (v: EntityOption | null) => void }) {
  const t = useTranslations("redLinesSettings");
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<EntityOption[]>([]);

  useEffect(() => {
    if (query.trim().length < 3) {
      setOptions([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      findEntitiesForRule(query.trim()).then((found) => live && setOptions(found), () => live && setOptions([]));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);

  if (value) {
    return (
      <p>
        {t("chosen", { label: value.label })}{" "}
        <button type="button" className="button-link" onClick={() => onChange(null)}>
          {t("change")}
        </button>
      </p>
    );
  }
  return (
    <div className="stack">
      <label>
        {t("entitySearch")}
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
      </label>
      {options.length > 0 && (
        <ul className="picker">
          {options.map((o) => (
            <li key={o.entityId}>
              <button type="button" className="button-link" onClick={() => onChange(o)}>
                {o.label}
              </button>
              {o.description && <span className="muted"> · {o.description}</span>}
            </li>
          ))}
        </ul>
      )}
      {query.trim().length >= 3 && options.length === 0 && <p className="hint">{t("entityNone")}</p>}
    </div>
  );
}

function exportVault(v: Vault) {
  const blob = new Blob([JSON.stringify(v, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "kwazat-red-lines.json";
  a.click();
  URL.revokeObjectURL(url);
}
