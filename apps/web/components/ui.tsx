import type { Icon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

type SectionIntroProps = {
  eyebrow: string;
  title: string;
  children: ReactNode;
  align?: "left" | "center";
};

export function SectionIntro({
  eyebrow,
  title,
  children,
  align = "left",
}: SectionIntroProps) {
  return (
    <div className={align === "center" ? "section-intro section-intro-center" : "section-intro"}>
      <p className="eyebrow">{eyebrow}</p>
      <h2 className="section-title">{title}</h2>
      <div className="section-copy">{children}</div>
    </div>
  );
}

export function IconChip({ icon: Icon }: { icon: Icon }) {
  return (
    <span className="icon-chip" aria-hidden="true">
      <Icon size={20} weight="regular" />
    </span>
  );
}

export function DemoChip() {
  return <span className="demo-chip">Demo data</span>;
}

export function ExternalLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a href={href} className={className} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}
