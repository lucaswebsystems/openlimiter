import { ButtonLink, SectionHeading } from "./ui";

/**
 * The web app.
 *
 * This is the slot a reference site of this shape gives to its newest product,
 * with a status chip beside the heading. Ours carries the word `planned` in that
 * chip because that is what it is. Every tile is drawn dashed and empty, the
 * prose says there is nothing to open, and the only button leads to the page
 * that explains what planned means here. Nothing on this section can be clicked
 * to reach a product.
 */

const intent = [
  {
    title: "The same local snapshot",
    detail:
      "A browser view over the cache the command line tool already writes. No new source of truth, no account, no server holding your numbers.",
  },
  {
    title: "Installable to a home screen",
    detail:
      "A progressive web app, so a long window can be checked away from the desk without anything being submitted to a store.",
  },
  {
    title: "Optional, always",
    detail:
      "The command line tool would keep working with no browser, no network and no synchronisation, exactly as it does today.",
  },
];

export function WebApp() {
  return (
    <section id="web-app">
      <SectionHeading
        title="Web app"
        status="planned"
        lead="Written down, not built. There is no build, no preview link and no waiting list, and this section will keep saying so until that changes."
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {intent.map((item) => (
          <div
            key={item.title}
            className="rounded-xl border border-dashed border-hairline-strong bg-canvas px-5 py-4"
          >
            <p className="text-sm font-medium text-heading">{item.title}</p>
            <p className="mt-2 text-sm leading-relaxed text-muted">{item.detail}</p>
          </div>
        ))}
      </div>
      <div className="mt-6">
        <ButtonLink href="/docs/roadmap">What planned means here</ButtonLink>
      </div>
    </section>
  );
}
