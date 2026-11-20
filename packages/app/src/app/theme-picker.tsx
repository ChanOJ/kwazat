"use client";

import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { THEMES, type Theme } from "@/lib/theme.ts";

const icons: Record<Theme, ReactNode> = {
  dark: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
  light: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8" />
    </>
  ),
  device: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="1.5" />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
};

export function ThemeIcon({ theme, size = 20 }: { theme: Theme; size?: number }) {
  return (
    <svg className="menu-icon" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {icons[theme]}
    </svg>
  );
}

/** The three theme buttons (dark, light, device), submitted to the server action `action`. */
export function ThemeChoices({
  action,
  current,
  names,
  onChoose,
}: {
  action: (formData: FormData) => void | Promise<void>;
  current: Theme;
  names: Record<Theme, string>;
  onChoose?: () => void;
}) {
  return (
    <form action={action} onSubmit={onChoose} className="theme-choices">
      {THEMES.map((theme) => (
        <button key={theme} type="submit" name="theme" value={theme} aria-pressed={theme === current}>
          <ThemeIcon theme={theme} />
          {names[theme]}
        </button>
      ))}
    </form>
  );
}

/**
 * Menu row opening a small "Choose your theme" dialog (portaled to <body>, like the language
 * dialog, so it survives the profile menu closing).
 */
export function ThemeDialog({
  action,
  current,
  names,
  role,
  labels,
  children,
}: {
  action: (formData: FormData) => void | Promise<void>;
  current: Theme;
  names: Record<Theme, string>;
  role?: string;
  labels: { title: string; close: string };
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [mounted, setMounted] = useState(false);

  const open = () => {
    setMounted(true);
    requestAnimationFrame(() => dialog.current?.showModal());
    const menu = document.querySelector<HTMLDetailsElement>("details.profile[open]");
    if (menu) menu.open = false;
  };

  return (
    <>
      <button type="button" role={role} aria-haspopup="dialog" onClick={open}>
        {children}
      </button>
      {mounted &&
        createPortal(
          <dialog
            ref={dialog}
            className="language-dialog theme-dialog"
            aria-labelledby="theme-title"
            onClick={(event) => event.target === dialog.current && dialog.current?.close()}
          >
            <div className="language-head">
              <h2 id="theme-title">{labels.title}</h2>
              <button type="button" className="icon-button" aria-label={labels.close} onClick={() => dialog.current?.close()}>
                ×
              </button>
            </div>
            <ThemeChoices action={action} current={current} names={names} onChoose={() => dialog.current?.close()} />
          </dialog>,
          document.body,
        )}
    </>
  );
}
