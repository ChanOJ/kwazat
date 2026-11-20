"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

const copyIcon = (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h9" />
  </svg>
);
const checkIcon = (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

/** The backup codes, with a button that copies them all (one per line) to the clipboard. */
export function BackupCodes({ codes }: { codes: string[] }) {
  const t = useTranslations("backupCodes");
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2500);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <>
      <ul className="codes">
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ul>
      <p>
        <button type="button" className="secondary icon-text" onClick={copy}>
          {state === "copied" ? checkIcon : copyIcon}
          {state === "copied" ? t("copied") : t("copy")}
        </button>
        <span role="status" className="error">
          {state === "failed" ? ` ${t("failed")}` : ""}
        </span>
      </p>
    </>
  );
}
