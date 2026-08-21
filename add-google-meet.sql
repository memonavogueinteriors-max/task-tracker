-- Google Meet Huddle link
alter table public.companies
add column if not exists google_meet_url text not null default '';
