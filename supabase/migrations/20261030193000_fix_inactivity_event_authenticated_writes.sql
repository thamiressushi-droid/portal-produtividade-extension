ALTER TABLE public.inactivity_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.inactivity_events FROM PUBLIC;
REVOKE ALL ON TABLE public.inactivity_events FROM anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.inactivity_events TO authenticated;

DROP POLICY IF EXISTS inactivity_events_authenticated_select
ON public.inactivity_events;
CREATE POLICY inactivity_events_authenticated_select
ON public.inactivity_events
FOR SELECT
TO authenticated
USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS inactivity_events_authenticated_insert
ON public.inactivity_events;
CREATE POLICY inactivity_events_authenticated_insert
ON public.inactivity_events
FOR INSERT
TO authenticated
WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS inactivity_events_authenticated_update
ON public.inactivity_events;
CREATE POLICY inactivity_events_authenticated_update
ON public.inactivity_events
FOR UPDATE
TO authenticated
USING (user_id = (SELECT auth.uid()))
WITH CHECK (user_id = (SELECT auth.uid()));
