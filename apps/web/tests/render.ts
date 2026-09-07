import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { expect } from "vitest";
import messages from "../messages/en.json";

/**
 * Mounting a component, with nothing else pretending to be a browser.
 *
 * The suite has no component testing library and does not need one: React
 * ships the two pieces this takes, a root and `act`, and jsdom supplies the
 * document.
 *
 * What it does not supply is the message catalog, because next-intl's client
 * entry reaches for the Next router and there is no router here. A test file
 * that mounts one of these screens stands `useTranslations` on the real
 * English catalog instead, which is stricter than the library: a key that is
 * missing throws rather than rendering its own path. The catalog exported
 * below is the same file the application imports, so a sentence asserted here
 * is the sentence that ships.
 */

declare global {
  /* The flag React reads before it will let `act` run. */
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

export interface Mounted {
  container: HTMLElement;
  /**
   * Run something that changes state, then let React finish with it.
   *
   * A callback that settles a promise is an async act, and an async act has to
   * be awaited by whoever called this: one that is not leaves React's act
   * queue busy, and nothing mounted later in the same file flushes again, not
   * even a fresh render. A sync callback still flushes before this returns, so
   * a press followed by a look at the screen keeps working unawaited.
   */
  run: (fn: () => void | PromiseLike<void>) => void | PromiseLike<void>;
  unmount: () => void;
}

/**
 * Let every promise already in flight settle, and React finish with what they
 * did. Anything that reaches for a session, a stored answer or a clipboard
 * answers on a microtask, so a test that presses a control has to give those
 * a turn before it looks at the screen.
 */
export async function flush(times = 2): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

export function render(node: ReactElement): Mounted {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    container,
    run: (fn) => act(fn as () => Promise<void>) as void | PromiseLike<void>,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** Every rendered element matching a selector, as an array rather than a list. */
export function all<T extends Element>(container: HTMLElement, selector: string): T[] {
  return [...container.querySelectorAll<T>(selector)];
}

/** The first element whose trimmed text is exactly this, or null. */
export function byText(container: HTMLElement, selector: string, text: string): Element | null {
  return all(container, selector).find((node) => node.textContent?.trim() === text) ?? null;
}

/**
 * Wait until the tree shows this sentence, flushing until it does.
 *
 * Some screens render nothing at all before their first effect: the install
 * step stays hidden until the browser has said what it offers, and the pair
 * page holds its first card until the fragment is consumed and the service has
 * answered. Counting flushes by hand is a race lost slowly, so this turns
 * until the sentence is there and reports the whole text when it never is.
 *
 * It waits on microtasks only, so fake timers cannot stall it.
 */
export async function findByText(
  container: HTMLElement,
  text: string,
  turns = 20,
): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if ((container.textContent ?? "").includes(text)) return;
    await flush();
  }
  expect(container.textContent).toContain(text);
}

/** The catalog, for a test that wants to assert against the shipped sentence. */
export { messages };
