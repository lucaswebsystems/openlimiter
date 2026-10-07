"use client";

import { useEffect } from "react";
import { applyTheme, isTheme, THEME_STORAGE_KEY } from "@/lib/theme";

function followsSystem(): boolean {
  try { return !isTheme(window.localStorage.getItem(THEME_STORAGE_KEY)); }
  catch { return true; }
}

export function FollowSystemTheme() {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const standalone = window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
    const follow = () => {
      if (standalone && followsSystem()) applyTheme("system");
    };
    follow();
    media.addEventListener("change", follow);
    window.addEventListener("storage", follow);
    return () => {
      media.removeEventListener("change", follow);
      window.removeEventListener("storage", follow);
    };
  }, []);
  return null;
}
