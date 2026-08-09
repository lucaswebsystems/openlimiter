import Link from "next/link";
import type { ReactNode } from "react";

const linkStyle =
  "focus-ring rounded text-accent underline underline-offset-4 transition-colors hover:text-accent-hover";

export function DocLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className={linkStyle}>
      {children}
    </Link>
  );
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={linkStyle}>
      {children}
    </a>
  );
}

/**
 * Documentation prose primitives.
 *
 * Docs pages are typed modules rather than markdown, so these components are
 * the whole formatting vocabulary. Keeping them here means one place decides
 * the rhythm, the type scale, and the colour tokens for every page.
 */

export function P({ children }: { children: ReactNode }) {
  return <p className="mt-4 font-sans text-sm leading-7 text-body">{children}</p>;
}

export function Sub({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h3
      id={id}
      className="mt-10 scroll-mt-24 font-sans text-base font-medium tracking-tight text-heading"
    >
      {children}
    </h3>
  );
}

export function Bullets({ items }: { items: readonly ReactNode[] }) {
  return (
    <ul className="mt-4 space-y-2.5">
      {items.map((item, index) => (
        <li key={index} className="flex gap-3 font-sans text-sm leading-7 text-body">
          <span aria-hidden="true" className="mt-3 h-1 w-1 flex-none rounded-full bg-hairline-strong" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

export function Steps({ items }: { items: readonly ReactNode[] }) {
  return (
    <ol className="mt-4 space-y-3">
      {items.map((item, index) => (
        <li key={index} className="flex gap-3 font-sans text-sm leading-7 text-body">
          <span className="mt-1 flex h-5 w-5 flex-none items-center justify-center rounded-md border border-hairline bg-surface font-mono text-2xs text-heading">
            {index + 1}
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ol>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded border border-hairline bg-code px-1.5 py-0.5 font-mono text-2xs text-heading">
      {children}
    </code>
  );
}

export function CodeBlock({ label, code }: { label?: string; code: string }) {
  return (
    <div className="mt-5 overflow-hidden rounded-xl border border-hairline bg-code">
      {label !== undefined && (
        <div className="flex items-center justify-between border-b border-hairline bg-surface px-4 py-2">
          <span className="font-mono text-2xs uppercase tracking-wider text-muted">{label}</span>
        </div>
      )}
      <pre className="overflow-x-auto px-4 py-4">
        <code className="font-mono text-2xs leading-6 text-heading">{code}</code>
      </pre>
    </div>
  );
}

const calloutTone = {
  /* The coloured callout. Reserved for guarantees and warnings that a reader
     must not skim past. */
  key: {
    box: "border-hairline bg-accent-subtle",
    rule: "bg-accent-solid",
    label: "text-accent",
  },
  note: {
    box: "border-hairline bg-surface",
    rule: "bg-hairline-strong",
    label: "text-muted",
  },
} as const;

export type CalloutTone = keyof typeof calloutTone;

export function Callout({
  tone = "note",
  title,
  children,
}: {
  tone?: CalloutTone;
  title: string;
  children: ReactNode;
}) {
  const styles = calloutTone[tone];
  return (
    <aside className={`mt-6 flex gap-4 overflow-hidden rounded-xl border ${styles.box} p-5`}>
      <span aria-hidden="true" className={`w-0.5 flex-none rounded-full ${styles.rule}`} />
      <div>
        <p className={`font-mono text-2xs uppercase tracking-widest ${styles.label}`}>{title}</p>
        <div className="mt-2 font-sans text-sm leading-7 text-heading">{children}</div>
      </div>
    </aside>
  );
}

export interface TableColumn {
  key: string;
  header: string;
}

export function Table({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: readonly TableColumn[];
  rows: readonly Readonly<Record<string, ReactNode>>[];
}) {
  return (
    <div className="mt-5 overflow-x-auto rounded-xl border border-hairline">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-hairline bg-surface">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className="px-4 py-2.5 font-mono text-2xs uppercase tracking-wider text-muted"
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-b border-hairline last:border-b-0">
              {columns.map((column) => (
                <td
                  key={column.key}
                  className="px-4 py-3 align-top font-sans text-sm leading-6 text-body"
                >
                  {row[column.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
