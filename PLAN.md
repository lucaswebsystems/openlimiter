# Internationalising the OpenLimiter marketing site

Branch `i18n-scaffold`. This plan describes the wave that puts five locales on
the marketing site and the documentation, extracts every English string into a
catalog, and leaves the four translation files ready for another lane to fill.

Nothing here reopens a settled decision. The decisions are listed once, in
section 1, and the rest of the document is how they get built.

## 1. What was settled

1. Locales: `en` (default, root URL, no prefix), `pt-BR`, `es`, `de`, `ja` at
   `/pt-BR`, `/es`, `/de`, `/ja`.
2. Scope: every marketing page (home, `/download`, `/alternatives`,
   `/alternatives/[slug]`, `/changelog` chrome, pricing, footer, nav, 404) plus
   every `/docs` page. The web application under `app/app/` stays English and
   its copy is not touched.
3. No automatic redirect on browser language. Middleware reads Accept-Language
   and, when the preferred language has a locale and no `NEXT_LOCALE` cookie
   exists, the page renders normally and a small dismissible banner offers the
   localised version **in that language**. Choosing switches route and sets the
   cookie. Dismissing sets the cookie too. A returning visitor with the cookie
   lands on their language when they hit the bare root.
4. A footer language switcher on every page in scope: flag plus native name,
   linking to the same page in the other locale, never to the home page.
5. Full SEO plumbing: hreflang alternates including `x-default`, sitemap entries
   per locale, `html lang` per locale, a canonical per localised page, and the
   JSON-LD blocks keep working. Social images stay English this wave.
6. Everything static at build time. `generateStaticParams` per locale, no client
   side translation fetching, and no layout shift from the banner.
7. One JSON catalog per locale under `apps/web/messages/`. `en.json` is the
   source of truth. Keys are semantic paths, never English sentences.
   `messages/GLOSSARY.md` names the terms that never translate.
8. A staleness gate, `apps/web/scripts/check-i18n.mjs`, that fails when `en.json`
   and any locale file disagree on their key set.
9. next-intl, unless the repo argues otherwise.
10. `apps/web` has its own `pnpm-lock.yaml`. Any dependency is recorded there
    with `pnpm install --ignore-workspace` inside `apps/web`, because CI runs
    `pnpm install --ignore-workspace --frozen-lockfile` there and Vercel builds
    that directory as its own root.

## 2. Library choice

next-intl 4.13.6. Peer range covers `next@^15` and `react@^19`, which is what
this app pins (15.5.20 and 19.2.8).

It is used for the message catalog, the request configuration, static rendering
via `setRequestLocale`, and the locale aware `Link` and `usePathname` helpers.
`useTranslations` works in Server Components as well as client ones, which keeps
the extraction diff small: a component that reads copy from the catalog does not
have to change from server to client to do it.

**Two deliberate deviations, both narrow.**

The middleware is ours, not `createMiddleware` on its own. Decision 3 is not the
behaviour next-intl ships: its middleware wants to redirect on a detected
locale, and it wants to write the locale cookie itself. Both are switched off in
the routing configuration (`localeDetection: false`, `localeCookie: false`) and
our `middleware.ts` composes next-intl's prefix normaliser inside the exact
logic decision 3 describes. next-intl still owns the rewriting and the
`/en/...` to `/...` redirect, so route resolution and the navigation helpers
cannot drift from each other.

The client provider receives a subset of the catalog, not all of it. Serialising
five namespaces instead of forty keeps the RSC payload of every page roughly the
size it is today, which is what decision 6 is protecting.

## 3. Routing shape, and how the root stays unprefixed

`localePrefix: 'as-needed'`. The marketing tree lives under `app/[locale]/` and
every locale including English is prerendered there, so `/en/download` exists on
disk as a static file. Middleware rewrites `/download` to `/en/download`, which
means the visitor's URL stays `/download` while the response is the prerendered
English file. The reverse also holds: a request that spells `/en/download` out
loud is redirected to `/download`, so English is reachable at exactly one URL
and there is no duplicate to canonicalise away.

```
app/
  [locale]/
    layout.tsx           root layout: <html lang>, chrome, provider
    page.tsx             home
    not-found.tsx        localised 404
    download/page.tsx
    changelog/page.tsx
    alternatives/page.tsx
    alternatives/[slug]/page.tsx
    docs/layout.tsx
    docs/**/page.tsx
  app/                   the web application, English, own root layout
  admin/                 internal console, English, own root layout
  blog/                  posts, English, own root layout
  not-found.tsx          last resort 404, own html and body
  icon.tsx apple-icon.tsx opengraph-image.tsx twitter-image.tsx
  sitemap.ts
  globals.css
```

### Why `app/layout.tsx` is deleted

`html lang` has to be right per locale in the served HTML, which means the
element has to be rendered by a layout that knows the locale, which means
`app/[locale]/layout.tsx` has to be a root layout. Next allows more than one
root layout only when there is no `app/layout.tsx` above them, so the file goes
and each top level tree renders its own document element.

To stop that becoming four copies of the same document, everything the old root
layout did lives in one component, `components/site-html.tsx`. It takes a locale
and renders the head scripts, the body, the announcement bar, the nav, the
footer, the reveal client, the back to top control and the analytics tag. Each
root layout is then a handful of lines that calls it. There is one place where
site chrome is defined, exactly as before.

### Why `/app`, `/admin` and `/blog` stay where they are

The dashboard is a service worker, a manifest, an installed window and a
generated engine directory. Moving it buys a marginally tidier tree and risks a
surface this wave is told not to touch, so it keeps its path and gains
`html` and `body` in the layout it already had. `/admin` and `/blog` get a new
three line layout each.

The middleware matcher therefore has to exclude those three prefixes, or the
rewrite to `/en/blog` would hit a route that does not exist. That exclusion is
the single most load bearing line in the middleware and it is commented as such.

Blog posts stay English and out of the localised tree. They are long form
content, the translation lane is not being handed them, and publishing five URLs
with one English body would be a worse outcome than one honest English URL.

## 4. Middleware

```
request
  |
  is it /app, /admin, /blog, or an asset?  -> pass straight through
  |
  is it the bare root, with NEXT_LOCALE naming a non default locale?
  |     -> redirect to /<locale>            (decision 3, returning visitor)
  |
  hand to next-intl: rewrite unprefixed to /en/..., redirect /en/... to /...
  |
  is NEXT_LOCALE absent?
        -> negotiate Accept-Language against the locale list
        -> when it resolves to a locale, set a readable `ol-lang-hint` cookie
```

The hint cookie is how a static page learns what the request headers said
without reading them. A page that calls `headers()` is a dynamic page, and
decision 6 forbids that, so the negotiation result is handed to the client on a
cookie the banner reads. `NEXT_LOCALE` keeps its one meaning throughout: the
visitor has chosen. Nothing but a click writes it.

The cookie redirect fires on the bare root only. A deep link stays the language
it spells, which is what a shared URL should do.

## 5. The banner

`components/locale-offer.tsx`, one client component, mounted from the locale
layout. It reads `ol-lang-hint`, checks `NEXT_LOCALE` is absent, checks the hint
is not the locale already being read, and renders one line plus two controls.

It is `fixed` at the bottom of the viewport and reserves no space in the flow,
so it cannot move a pixel of the page. It renders after hydration, so it is not
in the largest contentful paint either.

Its copy is in the suggested language, which is not the page's language, so the
strings cannot come from the page's catalog. The locale layout reads the
`localeOffer` namespace out of all five catalogs at build time and passes the
resulting map as a prop: three short strings per locale, written in that
language, still living in the catalog files.

Choosing writes `NEXT_LOCALE` and navigates. Dismissing writes `NEXT_LOCALE`
with the current locale and clears the hint.

## 6. The switcher

`components/locale-switcher.tsx`, in the footer, on every page in scope. Flag
emoji plus native name, and each entry is a real anchor carrying `hrefLang`, so
it is crawlable rather than a script only control.

It builds its targets from next-intl's `usePathname`, which returns the pathname
with the locale stripped, so every entry points at the same page in the other
locale and never at the home page. A click writes `NEXT_LOCALE` before the
navigation, which is what stops a visitor with a `pt-BR` cookie from being
bounced off English the moment they ask for it.

The three English only trees render the footer with the switcher suppressed:
they have no localised counterpart to point at.

## 7. Metadata, hreflang and the sitemap

One helper, `localePath(locale, route)`, turns a route into its URL for a
locale: the route itself for English, the route behind a prefix otherwise. Every
canonical, every alternate and every sitemap row is built from it, so the three
cannot disagree.

`lib/metadata.ts` grows `localeAlternates(route)`, which returns the canonical
plus a `languages` map holding all five locales and `x-default` pointing at
English. `pageMetadata` takes a locale and a route instead of a path and calls
it. Doc pages go through `docMetadata(href, locale)` and read their title and
description from the catalog.

`app/sitemap.ts` stays at the root and emits one row per route per locale, each
row carrying `alternates.languages`. It reads the same route list the pages do.

The JSON-LD builders in `lib/jsonld.ts` take a locale and read their prose from
the catalog. `inLanguage` is set per locale.

Social images stay English, per decision 5.

## 8. Extraction

`messages/en.json`, one file, semantic paths, top level namespace per section or
page:

```
meta            site title, description, title suffix
common          skip link, back to top, theme toggle, demo data chip
nav             header links and controls
footer          columns, brand paragraph, licence line
announce        the promo sentence, long and short
localeOffer     the banner, one entry per locale, in that locale
localeSwitcher  the control's label
hero download changelog alternatives notFound
worksWith runsWhere webApp integrations faq pricing about
docs            group titles, page titles and descriptions, prev and next
docs.<page>     that page's body
```

Rules the extraction follows.

Structure stays in TypeScript, prose moves to the catalog. `lib/docs.ts` keeps
its hrefs and its ordering and loses its titles and descriptions to
`docs.pages.<id>.*`. `lib/downloads.ts` keeps its platforms, its filenames and
its ship states and loses its prose. `lib/alternatives.ts` keeps its slugs and
its comparison shape and loses its sentences.

A sentence with a link inside it becomes one message with tags, read through
`t.rich`, not three fragments concatenated. Concatenation is how a translator
gets handed half a clause.

The announcement bar is the one place where the copy shape changes. Today it
carries `"Founding p"` plus `"romo: ..."` so a narrow screen can drop a word and
still open on a capital. A word split mid word cannot be translated, so the
catalog carries two whole sentences, `announce.message` and `announce.short`,
and the rendered result at both widths is the same text it is today.

Every locale file starts as a copy of `en.json`, so the build is green and the
staleness gate passes before a single word is translated. The four locale files
carry a `_status` note saying they are untranslated placeholders.

## 9. The staleness gate

`apps/web/scripts/check-i18n.mjs`. It flattens every catalog to its leaf key
paths and fails when a locale is missing a key `en.json` has, or carries one it
does not. It also fails on a duplicated or empty key, and it warns per locale
with a count of values still identical to English, which is how the translation
lane sees its own progress.

Wired in two places: `apps/web` runs it as the first step of `pnpm build`, so
Vercel cannot deploy a half translated catalog, and the workspace root gains
`pnpm test:i18n` inside `pnpm test`, so CI goes red on a copy change that
skipped retranslation. Same philosophy as `test:specs`.

## 10. Order of work

1. next-intl into `apps/web/package.json` and its own lockfile.
2. `i18n/` configuration, `messages/` catalogs, `GLOSSARY.md`.
3. `components/site-html.tsx`, the four root layouts, the route moves.
4. Middleware, banner, switcher.
5. Metadata helper, alternates, sitemap.
6. Extraction, page by page, English only.
7. `check-i18n.mjs`, wired both places.
8. Placeholder locale files from `en.json`.
9. `OL_DIST_DIR=.next-i18n pnpm --dir apps/web run build`.

## 11. What the build added to this plan

Nine things the plan did not anticipate and the code needed. Written down here
rather than only in the commits, because each one is a rule somebody will have to
keep.

**`components/site-link.tsx`, the one internal link.** An internal `<a href>`
loses the locale, and there are three right answers depending on the
destination: a localised route needs next-intl's `Link`, an English only tree
needs a plain one because a prefix in front of it is a 404, and a bare `#anchor`
is not a route at all. That was a bug waiting to be written at every call site,
so it is one decision made once, from the same list the middleware reads.
`ButtonLink` and `IconButtonLink` in `components/ui.tsx` route through it too:
they used to render a bare anchor for every destination, which was right when the
site had one language.

**`i18n/params.ts`, one call per page.** Validating the segment, calling
`setRequestLocale` and narrowing the string are three obligations that arrive
together and fail quietly apart. Missing the second one costs static rendering
with no error to show for it. `const locale = await pageLocale(params)` does all
three.

**`app/[locale]/[...rest]/page.tsx`, so a 404 knows its language.** A
`not-found` file cannot read `params`. Without a catch all to route through, an
unknown path under `/pt-BR` would reach the document root with no locale in scope
and be answered in English inside a `lang="en"` document.

**`DocArticle` takes an identifier, not a title.** Each documentation page used to
hand in its own `href`, `title` and `lead`, and the title also existed in the map
that draws the sidebar. In five languages that is ten copies of every heading.
The route now comes from the map and the words from the catalog.

**The announcement bar's copy shape changed, as the plan predicted, and one more
did.** `lib/site.ts` also held `PRO_PRICE_NOTE`, the one sentence allowed to name
the planned regular price. It moved to `pricing.pro.priceNote` and takes both
numbers as ICU arguments, so a translation cannot edit a price. The numbers stay
in `lib/site.ts` and only there.

**`localeOffer` is seeded in all five languages, not left English.** Three short
strings per locale. The banner appears on a page in a different language from
itself, so an English placeholder would have made the feature meaningless on day
one. They are seeded and flagged for the translation lane to review rather than
write.

**`scripts/seed-locales.mjs`.** Creates a catalog from English, and with `--fill`
adds only the keys a catalog lacks while leaving translated values alone. That is
the tool the next English copy change needs.

**next-intl's typed message augmentation was tried and dropped.** Declaring
`AppConfig` would have given typed locales and compile checked message keys,
which is a real guarantee worth having. It does not work here: next-intl
re-exports the interface from `use-intl` as a type alias, and declaration merging
does not cross a re-export, so the augmentation compiles and does nothing.
Silently doing nothing is worse than absent, so the file was removed.
`scripts/check-i18n.mjs` remains the guarantee, and one `hasLocale` narrowing in
`components/docs/doc-article.tsx` covers the one place that needed the type.

**`tsconfig.json` lost five stale include entries.** Next appends one per
`OL_DIST_DIR` it builds into, so the list had grown a line per finished agent
lane, each describing routes at their old paths. After the move they stopped
compiling and would have failed the build on artifacts nobody was using. A lane
that needs its entry gets it written back on its next build.

## 12. Left out on purpose

The blog, the admin console and the web application dashboard: English, by
decision or by risk, all three stated above.

Social card images: English, per decision 5.

Localised routing segments. `/pt-BR/download` keeps the English segment rather
than becoming `/pt-BR/baixar`. next-intl supports the translated variant and it
would be a second wave with its own redirect obligations for URLs already
indexed. Not this one.

Compile checked message keys. See section 11: the mechanism does not work in this
version and the runtime gate covers the same ground.

Translation. Four files, ready, untouched.
