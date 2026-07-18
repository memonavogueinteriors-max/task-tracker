-- TEAM TASK TRACKER — SUPABASE DATABASE
-- Run this entire file once in Supabase: SQL Editor → New query → Run

create extension if not exists pgcrypto;

create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'My Company',
  tagline text not null default 'Team Productivity Portal',
  logo_data_url text not null default '',
  primary_color text not null default '#C9A84C',
  header_color text not null default '#0B1730',
  header_color_2 text not null default '#1A3560',
  sheet_webhook_url text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.members (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id text not null,
  pin_hash text not null,
  name text not null,
  email text not null default '',
  role text not null check (role in ('owner','manager','sales')),
  manager_id uuid null references public.members(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, employee_id)
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  assigned_by uuid not null references public.members(id) on delete restrict,
  title text not null,
  task_date date not null,
  hours numeric(6,2) not null default 0 check (hours >= 0 and hours <= 24),
  status text not null default 'Pending' check (status in ('Pending','In Progress','Completed','On Hold','Review')),
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tasks_company_date_idx on public.tasks(company_id, task_date desc);
create index if not exists tasks_member_date_idx on public.tasks(member_id, task_date desc);

create table if not exists public.attendance (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  work_date date not null,
  login_time time null,
  logout_time time null,
  finished_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(member_id, work_date)
);

create index if not exists attendance_company_date_idx on public.attendance(company_id, work_date desc);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  recipient_id uuid not null references public.members(id) on delete cascade,
  sender_id uuid not null references public.members(id) on delete cascade,
  type text not null default 'ring' check (type in ('ring','task','system')),
  message text not null,
  task_id uuid null references public.tasks(id) on delete cascade,
  read_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists notifications_recipient_idx on public.notifications(recipient_id, created_at desc);

-- The browser never connects directly to these tables. All access is through Vercel server functions.
alter table public.companies enable row level security;
alter table public.members enable row level security;
alter table public.tasks enable row level security;
alter table public.attendance enable row level security;
alter table public.notifications enable row level security;

-- Fixed first company and Owner account.
insert into public.companies (
  id, name, tagline, primary_color, header_color, header_color_2
) values (
  '00000000-0000-0000-0000-000000000001',
  'My Company',
  'Team Productivity Portal',
  '#C9A84C',
  '#0B1730',
  '#1A3560'
) on conflict (id) do nothing;

insert into public.members (
  id, company_id, employee_id, pin_hash, name, email, role, active
) values (
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001',
  'OWNER',
  crypt('0000', gen_salt('bf', 10)),
  'Company Owner',
  '',
  'owner',
  true
) on conflict (company_id, employee_id) do nothing;
