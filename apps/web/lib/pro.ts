const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const SUPABASE_URL: string = supabaseUrl ?? "";
export const SUPABASE_ANON_KEY: string = supabaseAnonKey ?? "";

export const proRailsEnabled: boolean = true;
export const proConfigurationReady: boolean =
  SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0;
