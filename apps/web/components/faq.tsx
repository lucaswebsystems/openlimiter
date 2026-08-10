import { getTranslations } from "next-intl/server";
import { reveal, revealGroup } from "@/lib/motion";

/**
 * Frequently asked questions.
 *
 * Native `details` elements, so the whole block ships without a line of
 * JavaScript, keeps the keyboard and screen reader behaviour the browser
 * already provides, and never renders an answer at zero opacity waiting to be
 * revealed. A closed answer is simply not painted.
 *
 * ONE LIST, TWO READERS, AND NOW FIVE LANGUAGES
 * ---------------------------------------------
 * The home page also emits these as FAQPage structured data, so the answer a
 * person opens and the answer a machine parses have to be the same string. That
 * used to be guaranteed by both reading one exported array of literals. The
 * literals moved to the catalog when the site gained four more languages, so
 * what is exported now is the order of the questions and a function that reads
 * them: the page calls `faqItems(t)` for the structured data, this component
 * renders the same call, and they still cannot drift apart.
 *
 * Answers stay plain text, for the reason they always did: structured data
 * carries no markup, so an answer that needed a link would have to be written
 * twice.
 */

export interface FaqItem {
  question: string;
  answer: string;
}

/**
 * The questions, in the order they are asked.
 *
 * The identifier is the catalog key, so `faq.items.pro.question` is the last
 * card in the grid. Ordering lives here because it is a judgement about what a
 * reader needs first and is the same judgement in every language.
 */
export const FAQ_IDS = [
  "whatLeaves",
  "safeToPoint",
  "promptHook",
  "providersToday",
  "apiKey",
  "routing",
  "connectorBreaks",
  "desktopOrPhone",
  "free",
  "pro",
] as const;

/**
 * The rendered list, for whichever of the two readers is asking.
 *
 * It takes the translator rather than a locale so the caller's `t` and this
 * function's `t` are the same object, which is what keeps the structured data
 * and the visible cards on the same catalog for the same request.
 */
export function faqItems(t: (key: string) => string): readonly FaqItem[] {
  return FAQ_IDS.map((id) => ({
    question: t(`items.${id}.question`),
    answer: t(`items.${id}.answer`),
  }));
}

/**
 * The chevron. One glyph that rotates a quarter turn on open rather than two
 * glyphs swapping places, which is what a reader expects from an accordion and
 * what the pointer response elsewhere on the site already implies.
 */
function Chevron() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4 flex-none text-muted transition-transform duration-200 group-open:rotate-90 group-hover:text-accent"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 5 7 7-7 7" />
    </svg>
  );
}

export async function Faq() {
  const t = await getTranslations("faq");
  const items = faqItems(t);

  return (
    <div id="faq" className="space-y-6">
      <h2 className="text-center text-3xl font-medium text-heading" {...reveal}>
        {t("title")}
      </h2>
      {/* Two columns from the large breakpoint. Nine items in one column ran
          past a screen height on their own; in two they read as a block, and
          each item is a self contained card so an open answer pushes only its
          own column. */}
      <div className="grid gap-3 lg:grid-cols-2 lg:gap-x-4" {...revealGroup}>
        {items.map((item, index) => (
          <details
            key={FAQ_IDS[index]}
            className="lift-sm elev-1 group h-fit rounded-xl border border-hairline bg-surface transition-colors hover:border-hairline-strong open:border-hairline-strong open:bg-raised"
            {...reveal}
          >
            <summary className="focus-ring-inset flex cursor-pointer list-none items-start gap-3 rounded-xl px-4 py-3.5 text-sm font-medium text-heading transition-colors duration-200 group-hover:text-accent">
              <Chevron />
              <span className="heading-face min-w-0">{item.question}</span>
            </summary>
            <div className="border-t border-hairline px-4 py-3.5 pl-11 text-sm leading-relaxed text-muted">
              {item.answer}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
