/** A completion scheduled loop shared by foreground events and manual retry. */
export function serialPoll(run: () => Promise<void>, interval: number) {
  let stopped = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = async () => {
    if (stopped || pending || document.hidden || document.visibilityState === "hidden") return;
    clearTimeout(timer);
    pending = true;
    try { await run(); } finally {
      pending = false;
      if (!stopped) timer = setTimeout(() => { void refresh(); }, interval);
    }
  };
  const foreground = () => { void refresh(); };
  window.addEventListener("focus", foreground);
  document.addEventListener("visibilitychange", foreground);
  void refresh();
  return {
    refresh,
    stop() {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener("focus", foreground);
      document.removeEventListener("visibilitychange", foreground);
    },
  };
}
