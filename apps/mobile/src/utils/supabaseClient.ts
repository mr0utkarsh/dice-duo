import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseClientEnabled = Boolean(
  supabaseUrl &&
    supabaseAnonKey &&
    !supabaseUrl.includes('your-project-ref') &&
    !supabaseAnonKey.includes('placeholder')
);

/**
 * Optional client-side Supabase instance using ONLY the public anon key.
 * Service-role credentials are NEVER included in client bundles.
 */
export const supabaseClient: SupabaseClient | null = isSupabaseClientEnabled
  ? createClient(supabaseUrl!, supabaseAnonKey!)
  : null;
