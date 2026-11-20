"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** Renders its children everywhere except in the login and signup funnels. */
export function HideInLogin({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const inFunnel = ["/login", "/signup"].some((p) => pathname === p || pathname.startsWith(`${p}/`));
  return inFunnel ? null : children;
}
