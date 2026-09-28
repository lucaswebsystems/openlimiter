import { FlatCompat } from "@eslint/eslintrc";
import path from "node:path";
import { fileURLToPath } from "node:url";

const filename = fileURLToPath(import.meta.url);
const directory = path.dirname(filename);
const compat = new FlatCompat({ baseDirectory: directory });

const config = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [".next/**", "out/**", "node_modules/**", "next-env.d.ts", "app/app/engine/generated/**"],
  },
  /* The next/og image routes can only draw <img>. The rule's own exemption for
     them matches on the path separator, so an inline disable was needed on
     Windows and reported as unused on Linux; turning it off here holds on both. */
  {
    files: ["app/icon.tsx", "app/apple-icon.tsx", "app/opengraph-image.tsx"],
    rules: { "@next/next/no-img-element": "off" },
  },
];

export default config;
