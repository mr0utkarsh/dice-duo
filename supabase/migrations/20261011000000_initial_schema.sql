-- ============================================================================
-- DICE DUO — Supabase PostgreSQL Schema & Row Level Security (RLS)
-- Migration: 20261011000000_initial_schema.sql
-- ============================================================================

create extension if not exists "pgcrypto";

-- 1. Profiles Table
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null check (char_length(trim(username)) between 2 and 24),
  preferred_color text not null default 'RED' check (preferred_color in ('RED', 'GREEN', 'YELLOW', 'BLUE')),
  games_played integer not null default 0 check (games_played >= 0),
  games_won integer not null default 0 check (games_won >= 0),
  captures_total integer not null default 0 check (captures_total >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2. User Settings Table
create table if not exists public.user_settings (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  sound_enabled boolean not null default true,
  haptics_enabled boolean not null default true,
  default_allow_custom_mode boolean not null default false,
  updated_at timestamptz not null default now()
);

-- 3. Matches History Table (written authoritatively by the server)
create table if not exists public.matches (
  id text primary key,
  room_code text not null check (char_length(room_code) = 6),
  max_players smallint not null check (max_players in (2, 3, 4)),
  is_public_matchmaking boolean not null default false,
  custom_mode_used boolean not null default false,
  winner_profile_id uuid references public.profiles(id) on delete set null,
  winner_name text not null,
  winner_color text not null check (winner_color in ('RED', 'GREEN', 'YELLOW', 'BLUE')),
  total_turns integer not null default 1 check (total_turns >= 1),
  rankings_json jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz not null default now()
);

-- 4. Match Players Table
create table if not exists public.match_players (
  id uuid primary key default gen_random_uuid(),
  match_id text not null references public.matches(id) on delete cascade,
  profile_id uuid references public.profiles(id) on delete set null,
  player_name text not null,
  player_color text not null check (player_color in ('RED', 'GREEN', 'YELLOW', 'BLUE')),
  finished_rank smallint not null check (finished_rank between 1 and 4),
  rolls_count integer not null default 0,
  sixes_count integer not null default 0,
  captures_made integer not null default 0,
  times_captured integer not null default 0,
  custom_rolls_used integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_matches_completed_at on public.matches(completed_at desc);
create index if not exists idx_match_players_match_id on public.match_players(match_id);
create index if not exists idx_match_players_profile_id on public.match_players(profile_id);

-- ============================================================================
-- Row Level Security (RLS) Policies
-- ============================================================================

alter table public.profiles enable row level security;
alter table public.user_settings enable row level security;
alter table public.matches enable row level security;
alter table public.match_players enable row level security;

-- Profiles: Anyone can read leaderboard/profile summaries; users can only update their own display info
create policy "Profiles are viewable by everyone"
  on public.profiles for select
  using (true);

create policy "Users can insert their own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

create policy "Users can update their own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- User Settings: Strictly private to the owning user
create policy "Users can view their own settings"
  on public.user_settings for select
  using (auth.uid() = user_id);

create policy "Users can insert their own settings"
  on public.user_settings for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own settings"
  on public.user_settings for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Matches & Match Players: Publicly readable for match history; write operations
-- are restricted to the backend server using the Supabase service_role key.
create policy "Matches are viewable by everyone"
  on public.matches for select
  using (true);

create policy "Match players are viewable by everyone"
  on public.match_players for select
  using (true);

-- ============================================================================
-- Auth Trigger: Auto-create Profile & Settings on Supabase Auth Sign-Up
-- ============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, username)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data->>'username'), ''), 'Player_' || substr(new.id::text, 1, 6))
  )
  on conflict (id) do nothing;

  insert into public.user_settings (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
