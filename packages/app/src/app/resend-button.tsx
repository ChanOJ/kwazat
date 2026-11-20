"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

/**
 * "Send a new code", greyed out with a countdown while the server would refuse it anyway.
 * `seconds` is the wait when the page was rendered; `namespace` holds `resend` and `resendIn`.
 */
export function ResendButton({
  seconds,
  namespace,
  disabled,
  ...button
}: { seconds: number; namespace: "code" | "twoFactor"; disabled?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const t = useTranslations(namespace);
  const [left, setLeft] = useState(Math.max(0, Math.ceil(seconds)));
  useEffect(() => {
    if (left <= 0) return;
    const timer = setTimeout(() => setLeft(left - 1), 1000);
    return () => clearTimeout(timer);
  }, [left]);
  return (
    <button type="submit" className="link-button" disabled={disabled || left > 0} {...button}>
      {left > 0 ? t("resendIn", { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` }) : t("resend")}
    </button>
  );
}
