-- TASK TRACKER UPGRADE: 1-3-5 PRIORITIES, DEVELOPER DEPARTMENT, EMAIL SETTINGS
-- Run this ONCE in the same Supabase project used by Vercel.

begin;

alter table public.companies
  add column if not exists owner_notification_email text not null default '',
  add column if not exists email_notifications_enabled boolean not null default true;

alter table public.members
  drop constraint if exists members_role_check;

alter table public.members
  add constraint members_role_check
  check (role in ('owner','manager','sales','developer'));

alter table public.tasks
  add column if not exists priority text not null default 'Medium';

update public.tasks
set priority = 'Medium'
where priority is null or priority not in ('High','Medium','Low');

alter table public.tasks
  drop constraint if exists tasks_priority_check;

alter table public.tasks
  add constraint tasks_priority_check
  check (priority in ('High','Medium','Low'));

create index if not exists tasks_member_date_priority_idx
  on public.tasks(member_id, task_date desc, priority);

commit;

-- Verification
select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name in ('companies','members','tasks')
  and column_name in ('owner_notification_email','email_notifications_enabled','role','priority')
order by table_name, column_name;
