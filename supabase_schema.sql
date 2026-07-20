-- RX WA — Supabase schema (يلصق في SQL Editor بمشروع Supabase)
-- شغّل هذا السكربت مرة وحدة بعد ما تسوي المشروع

-- جدول العملاء (multi-tenant)
create table if not exists clients (
  id text primary key,
  name text not null,
  phone_id text,
  wa_token text,
  flow text default 'qa',
  owner_email text,
  system_prompt text,
  maintenance_msg text,
  store jsonb
);

-- جدول الأسئلة الشائعة لكل عميل
create table if not exists qa (
  id bigserial primary key,
  client_id text not null,
  question text,
  keywords text,
  reply text
);

-- جدول المستخدمين (موظفين + مالك)
create table if not exists users (
  username text primary key,
  client_id text,
  password text,
  role text default 'staff',
  email text
);

-- جدول الرسائل (الأهم — بديل store.json)
create table if not exists messages (
  id bigserial primary key,
  client_id text not null,
  from_num text not null,
  direction text not null,         -- 'in' أو 'out'
  body text,                        -- نص الرسالة (موحد)
  media_type text,                  -- image/video/document/audio/null
  media_url text,
  at timestamptz default now(),
  read boolean default false
);

create index if not exists idx_messages_client on messages(client_id);
create index if not exists idx_messages_from on messages(client_id, from_num);

-- صلاحيات: نسمح للـ service_role (اللي نستخدمه بالسيرفر) بكل شي
-- ملاحظة: لا تستخدمي anon key بالسيرفر — استخدمي service_role key
