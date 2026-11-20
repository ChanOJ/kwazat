"use client";

import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type LanguageOption = { code: string; name: string };

/**
 * "Choose your language" dialog, opened by `children` (the trigger's content). Submits to the
 * server action `action` with a `locale` field; `auto` adds a "browser language" choice (accounts).
 * The dialog is portaled to <body> so it survives the profile menu closing.
 */
export function LanguagePicker({
  action,
  options,
  current,
  auto,
  className,
  role,
  labels,
  children,
}: {
  action: (formData: FormData) => void | Promise<void>;
  options: LanguageOption[];
  /** Selected language code, or "auto". */
  current: string;
  auto?: string;
  className?: string;
  role?: string;
  labels: { title: string; search: string; close: string };
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [mounted, setMounted] = useState(false);
  const all: LanguageOption[] = auto ? [{ code: "auto", name: auto }, ...options] : options;
  const needle = query.trim().toLowerCase();
  const shown = all.filter((o) => !needle || o.name.toLowerCase().includes(needle) || o.code.includes(needle));

  const open = () => {
    setMounted(true);
    setQuery("");
    // The dialog exists after this render.
    requestAnimationFrame(() => dialog.current?.showModal());
    const menu = document.querySelector<HTMLDetailsElement>("details.profile[open]");
    if (menu) menu.open = false;
  };

  return (
    <>
      <button type="button" className={className} role={role} aria-haspopup="dialog" onClick={open}>
        {children}
      </button>
      {mounted &&
        createPortal(
          <dialog
            ref={dialog}
            className="language-dialog"
            aria-labelledby="language-title"
            onClick={(event) => event.target === dialog.current && dialog.current?.close()}
          >
            <div className="language-head">
              <h2 id="language-title">{labels.title}</h2>
              <button type="button" className="icon-button" aria-label={labels.close} onClick={() => dialog.current?.close()}>
                ×
              </button>
            </div>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={labels.search}
              aria-label={labels.search}
            />
            <form action={action} onSubmit={() => dialog.current?.close()} className="language-grid">
              {shown.map((o) => (
                <button key={o.code} type="submit" name="locale" value={o.code} aria-pressed={o.code === current} lang={o.code === "auto" ? undefined : o.code}>
                  {o.name}
                  {o.code === current && <span aria-hidden="true"> ✓</span>}
                </button>
              ))}
            </form>
          </dialog>,
          document.body,
        )}
    </>
  );
}
