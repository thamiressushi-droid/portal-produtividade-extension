ALTER TABLE public.web_events
ADD COLUMN IF NOT EXISTS client_event_id uuid;

UPDATE public.web_events
SET client_event_id = gen_random_uuid()
WHERE client_event_id IS NULL;

ALTER TABLE public.web_events
ALTER COLUMN client_event_id SET DEFAULT gen_random_uuid(),
ALTER COLUMN client_event_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS web_events_client_event_id_key
ON public.web_events (client_event_id);

ALTER TABLE public.inactivity_events
ADD COLUMN IF NOT EXISTS client_event_id uuid;

UPDATE public.inactivity_events
SET client_event_id = gen_random_uuid()
WHERE client_event_id IS NULL;

ALTER TABLE public.inactivity_events
ALTER COLUMN client_event_id SET DEFAULT gen_random_uuid(),
ALTER COLUMN client_event_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS inactivity_events_client_event_id_key
ON public.inactivity_events (client_event_id);
