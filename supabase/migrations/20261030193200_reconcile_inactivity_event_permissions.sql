ALTER TABLE public.inactivity_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.inactivity_events FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE
ON TABLE public.inactivity_events
TO authenticated;

DO $$
DECLARE
  inactivity_sequence regclass;
  existing_policy record;
BEGIN
  FOR existing_policy IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'inactivity_events'
  LOOP
    EXECUTE format(
      'DROP POLICY %I ON public.inactivity_events',
      existing_policy.policyname
    );
  END LOOP;

  inactivity_sequence :=
    pg_get_serial_sequence('public.inactivity_events', 'id')::regclass;
  IF inactivity_sequence IS NOT NULL THEN
    EXECUTE format(
      'GRANT USAGE, SELECT ON SEQUENCE %s TO authenticated',
      inactivity_sequence
    );
  END IF;
END;
$$;

CREATE POLICY inactivity_events_authenticated_select
ON public.inactivity_events
FOR SELECT
TO authenticated
USING (user_id = (SELECT auth.uid()));

CREATE POLICY inactivity_events_authenticated_insert
ON public.inactivity_events
FOR INSERT
TO authenticated
WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY inactivity_events_authenticated_update
ON public.inactivity_events
FOR UPDATE
TO authenticated
USING (user_id = (SELECT auth.uid()))
WITH CHECK (user_id = (SELECT auth.uid()));
