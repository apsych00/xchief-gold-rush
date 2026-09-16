-- Dev-only OTP capture. When the otp-email hook has no ELASTIC_API_KEY configured, it stores the
-- login code here instead of sending mail, so the login flow can be tested without an email
-- provider. Production always has the key, so this table stays empty there. Service role only:
-- no client role can read or write it.

create table public.dev_otps (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  token text not null,
  created_at timestamptz not null default now()
);
create index dev_otps_email_created on public.dev_otps (email, created_at desc);

alter table public.dev_otps enable row level security;
revoke all on public.dev_otps from public, anon, authenticated;
