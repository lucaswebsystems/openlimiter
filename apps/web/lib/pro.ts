/**
 * The Pro rails feature flag, and the only place it is decided.
 *
 * The rails are ON only when the build carries both public Supabase values.
 * Neither is set anywhere today (not locally, not in CI, not on the host), so
 * every current build renders the rails off, ships no Supabase code to any
 * page, and the /admin route states plainly that it is not enabled.
 *
 * Both values are read as full static expressions because that is what Next
 * inlines into client bundles at build time. They are publishable values by
 * design (the URL and the anon key of a Supabase project, which row level
 * security treats as untrusted); no secret ever belongs in this file or in
 * this repo. The server side of Pro lives in a separate private repo.
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const SUPABASE_URL: string = supabaseUrl ?? "";
export const SUPABASE_ANON_KEY: string = supabaseAnonKey ?? "";

/** False the moment either value is absent, which is the current state everywhere. */
export const proRailsEnabled: boolean = SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0;

/**
 * The founder's Supabase user id, for the /admin gate. A user id is an opaque
 * UUID, not a credential: the real boundary is row level security, and this
 * gate only decides whether the console UI renders for a signed in session.
 */
export const FOUNDER_USER_ID: string = process.env.NEXT_PUBLIC_FOUNDER_USER_ID ?? "";
