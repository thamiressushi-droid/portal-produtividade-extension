ALTER TABLE public.web_events
ADD COLUMN IF NOT EXISTS screen_context text;
