/* The canonical lockup is an embedded SVG data URI, not a network image. */
/* eslint-disable @next/next/no-img-element */
import {
  BRAND_LOCKUP_DARK_DATA_URI,
  BRAND_LOCKUP_LIGHT_DATA_URI,
  BRAND_MARK_DATA_URI,
} from "@/lib/brand.generated";

function heightClasses(classes: string) {
  return classes
    .split(/\s+/)
    .filter((name) => !name.startsWith("w-") && !name.includes(":w-"))
    .join(" ");
}

/**
 * The square mark. Its URI is generated from the frozen live lockup, so this
 * component contains no copy of the artwork.
 */
export function BrandMark({
  className = "h-6 w-6 text-brand",
}: {
  className?: string;
  draw?: boolean;
  variant?: "full" | "small";
}) {
  return <img src={BRAND_MARK_DATA_URI} className={className} alt="" aria-hidden="true" />;
}

/**
 * The exact live header lockup. Height is the caller's former mark height, so
 * every existing placement keeps its measured scale while mark, gap and type
 * remain a single frozen piece of artwork.
 */
export function BrandLockup({
  markClassName = "h-8 w-8 flex-none text-brand sm:h-9 sm:w-9",
}: {
  markClassName?: string;
  wordClassName?: string;
  draw?: boolean;
}) {
  const size = heightClasses(markClassName);
  return (
    <span className={`brand-lockup relative inline-grid flex-none ${size}`} role="img" aria-label="OpenLimiter">
      <img className="brand-lockup-image brand-lockup-light h-full w-auto" src={BRAND_LOCKUP_LIGHT_DATA_URI} alt="" />
      <img className="brand-lockup-image brand-lockup-dark h-full w-auto" src={BRAND_LOCKUP_DARK_DATA_URI} alt="" />
    </span>
  );
}
