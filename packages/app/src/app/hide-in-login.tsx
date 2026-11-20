"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** Renders its children everywhere except in the login funnel (/login and below). */
export function HideInLogin({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return pathname === "/login" || pathname.startsWith("/login/") ? null : children;
}
