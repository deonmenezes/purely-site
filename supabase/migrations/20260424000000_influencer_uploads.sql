-- Storage bucket for influencer uploads (screenshots + screen recordings)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'influencer-uploads',
  'influencer-uploads',
  true,
  104857600, -- 100 MB per file
  array[
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'video/mp4',
    'video/quicktime',
    'video/webm'
  ]
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Public read access
drop policy if exists "influencer_uploads_public_read" on storage.objects;
create policy "influencer_uploads_public_read"
  on storage.objects for select
  using (bucket_id = 'influencer-uploads');

-- Anonymous insert access (anyone can upload)
drop policy if exists "influencer_uploads_anon_insert" on storage.objects;
create policy "influencer_uploads_anon_insert"
  on storage.objects for insert
  with check (bucket_id = 'influencer-uploads');

-- Metadata table for uploader name + caption
create table if not exists public.influencer_submissions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text,
  handle text,
  caption text,
  file_path text not null,
  file_url text not null,
  file_type text not null,
  file_size bigint
);

alter table public.influencer_submissions enable row level security;

drop policy if exists "submissions_public_read" on public.influencer_submissions;
create policy "submissions_public_read"
  on public.influencer_submissions for select
  using (true);

drop policy if exists "submissions_anon_insert" on public.influencer_submissions;
create policy "submissions_anon_insert"
  on public.influencer_submissions for insert
  with check (true);

create index if not exists influencer_submissions_created_at_idx
  on public.influencer_submissions (created_at desc);
