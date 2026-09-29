import { beforeEach, vi } from "vitest";

// jsdom has no media query engine. Keep browser controls mounted with a
// deterministic default; a test can override this for a particular query.
beforeEach(() => {
  // Node environment test files have no window to extend.
  if (typeof window === "undefined") return;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })),
  });
});
