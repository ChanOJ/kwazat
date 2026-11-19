"use client";

import { useEffect } from "react";

/** Closes the open profile menu on a click outside it, on Escape, and after navigation. */
export function ProfileClose() {
  useEffect(() => {
    const close = (event: Event) => {
      const menu = document.querySelector<HTMLDetailsElement>("details.profile[open]");
      if (!menu) return;
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !menu.contains(event.target as Node) || (event.target as Element).closest("a")) {
        menu.open = false;
      }
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", close);
    };
  }, []);
  return null;
}
