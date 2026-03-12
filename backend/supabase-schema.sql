-- ============================================================
-- Supabase SQL Schema — Portfolio Management Dashboard
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ============================================================

-- 1. PROFILES TABLE
-- Extends Supabase Auth users with app-specific profile data.
-- Linked to auth.users via id (1:1 relationship).
create table if not exists profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    username text unique not null,
    full_name text,
    avatar_url text,
    created_at timestamptz default now() not null
);

-- Enable Row Level Security
alter table profiles enable row level security;

-- Profiles policies: users can only read/update their own profile
create policy "Users can view own profile"
    on profiles for select
    using (auth.uid() = id);

create policy "Users can update own profile"
    on profiles for update
    using (auth.uid() = id);

create policy "Users can insert own profile"
    on profiles for insert
    with check (auth.uid() = id);

-- Auto-create profile on signup (trigger)
create or replace function public.handle_new_user()
returns trigger as $$
begin
    insert into public.profiles (id, username)
    values (new.id, coalesce(new.raw_user_meta_data->>'username', new.email));
    return new;
end;
$$ language plpgsql security definer;

create or replace trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();


-- 2. PORTFOLIOS TABLE
-- Each user can have multiple portfolio clients.
create table if not exists portfolios (
    id bigint generated always as identity primary key,
    user_id uuid not null references profiles(id) on delete cascade,
    name text not null,
    risk text not null check (risk in ('high', 'medium', 'low')),
    risk_label text not null,
    stock_pct double precision default 0,
    bond_pct double precision default 0,
    portfolio_value double precision default 0,
    initial_investment double precision default 0,
    performance_history jsonb default '[]'::jsonb,
    created_at timestamptz default now() not null,
    updated_at timestamptz default now() not null
);

-- Enable Row Level Security
alter table portfolios enable row level security;

-- Portfolios policies: users can only CRUD their own portfolios
create policy "Users can view own portfolios"
    on portfolios for select
    using (auth.uid() = user_id);

create policy "Users can insert own portfolios"
    on portfolios for insert
    with check (auth.uid() = user_id);

create policy "Users can update own portfolios"
    on portfolios for update
    using (auth.uid() = user_id);

create policy "Users can delete own portfolios"
    on portfolios for delete
    using (auth.uid() = user_id);

-- Index for fast user lookups
create index if not exists idx_portfolios_user_id on portfolios(user_id);

-- Auto-update updated_at timestamp
create or replace function update_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

create or replace trigger portfolios_updated_at
    before update on portfolios
    for each row execute function update_updated_at();


-- 3. HOLDINGS TABLE
-- Each portfolio has multiple holdings (stocks/bonds).
create table if not exists holdings (
    id bigint generated always as identity primary key,
    portfolio_id bigint not null references portfolios(id) on delete cascade,
    ticker text not null,
    name text not null,
    type text not null check (type in ('stock', 'bond')),
    type_label text not null,
    sector text,
    allocation_pct double precision default 0,
    value double precision default 0,
    cost_basis double precision default 0,
    shares integer default 0,
    price double precision default 0,
    previous_close double precision default 0,
    currency text default 'USD',
    created_at timestamptz default now() not null
);

-- Enable Row Level Security
alter table holdings enable row level security;

-- Holdings policies: users can only access holdings of their own portfolios
create policy "Users can view own holdings"
    on holdings for select
    using (
        exists (
            select 1 from portfolios
            where portfolios.id = holdings.portfolio_id
            and portfolios.user_id = auth.uid()
        )
    );

create policy "Users can insert own holdings"
    on holdings for insert
    with check (
        exists (
            select 1 from portfolios
            where portfolios.id = portfolio_id
            and portfolios.user_id = auth.uid()
        )
    );

create policy "Users can update own holdings"
    on holdings for update
    using (
        exists (
            select 1 from portfolios
            where portfolios.id = holdings.portfolio_id
            and portfolios.user_id = auth.uid()
        )
    );

create policy "Users can delete own holdings"
    on holdings for delete
    using (
        exists (
            select 1 from portfolios
            where portfolios.id = holdings.portfolio_id
            and portfolios.user_id = auth.uid()
        )
    );

-- Index for fast portfolio lookups
create index if not exists idx_holdings_portfolio_id on holdings(portfolio_id);


-- ============================================================
-- RELATIONSHIP DIAGRAM:
--
--   auth.users (Supabase Auth)
--       │
--       │  1:1 (on delete cascade)
--       ▼
--   profiles
--       │
--       │  1:N (on delete cascade)
--       ▼
--   portfolios
--       │
--       │  1:N (on delete cascade)
--       ▼
--   holdings
--
-- ============================================================
-- ROW LEVEL SECURITY SUMMARY:
--
--   profiles  → user can only see/edit their own profile
--   portfolios → user can only CRUD their own portfolios
--   holdings  → user can only CRUD holdings of their own portfolios
--
-- All policies use auth.uid() — Supabase's built-in function
-- that returns the logged-in user's UUID from the JWT.
-- ============================================================
