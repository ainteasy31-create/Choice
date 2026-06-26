-- 20260626000002_location_features.sql
-- Dynamic location pages: get_locations RPC, location_notifications table + trigger

-- ── location_notifications ─────────────────────────────────────────────────
-- Tracks when a city+state combo first appears in public.properties.
-- Existing combos are back-filled as dismissed=true so only truly new
-- locations surface as actionable notifications.
CREATE TABLE IF NOT EXISTS public.location_notifications (
  id           uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  city         text        NOT NULL,
  state        text        NOT NULL,
  property_id  text,
  detected_at  timestamptz DEFAULT now() NOT NULL,
  dismissed    boolean     DEFAULT false NOT NULL,
  CONSTRAINT uq_location_city_state UNIQUE (city, state)
);

ALTER TABLE public.location_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_location_notifs" ON public.location_notifications
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── get_locations() ────────────────────────────────────────────────────────
-- Returns all distinct city+state combos that have active listings.
-- Accessible to anon for the public hub page.
CREATE OR REPLACE FUNCTION public.get_locations()
RETURNS TABLE(
  city      text,
  state     text,
  count     bigint,
  min_rent  integer,
  max_rent  integer
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    city,
    state,
    COUNT(*)::bigint           AS count,
    MIN(monthly_rent)::integer AS min_rent,
    MAX(monthly_rent)::integer AS max_rent
  FROM public.properties
  WHERE status = 'active'
    AND city  IS NOT NULL AND trim(city)  <> ''
    AND state IS NOT NULL AND trim(state) <> ''
  GROUP BY city, state
  ORDER BY COUNT(*) DESC, state ASC, city ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_locations() TO anon, authenticated;

-- ── get_location_notifications() ───────────────────────────────────────────
-- Admin-only: returns undismissed notifications for new city+state combos.
CREATE OR REPLACE FUNCTION public.get_location_notifications()
RETURNS TABLE(
  id          uuid,
  city        text,
  state       text,
  property_id text,
  detected_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, city, state, property_id, detected_at
  FROM public.location_notifications
  WHERE dismissed = false
  ORDER BY detected_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_location_notifications() TO authenticated;

-- ── dismiss_location_notification() ────────────────────────────────────────
-- Admin-only: marks a city+state notification as dismissed.
CREATE OR REPLACE FUNCTION public.dismiss_location_notification(p_city text, p_state text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.location_notifications
  SET dismissed = true
  WHERE city = p_city AND state = p_state;
$$;

GRANT EXECUTE ON FUNCTION public.dismiss_location_notification(text, text) TO authenticated;

-- ── Trigger: detect new city+state on property INSERT ──────────────────────
CREATE OR REPLACE FUNCTION public._trg_detect_new_location()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.city  IS NOT NULL AND trim(NEW.city)  <> ''
  AND NEW.state IS NOT NULL AND trim(NEW.state) <> '' THEN
    INSERT INTO public.location_notifications (city, state, property_id, dismissed)
    VALUES (trim(NEW.city), upper(trim(NEW.state)), NEW.id, false)
    ON CONFLICT (city, state) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_detect_new_location ON public.properties;
CREATE TRIGGER trg_detect_new_location
  AFTER INSERT ON public.properties
  FOR EACH ROW
  EXECUTE FUNCTION public._trg_detect_new_location();

-- ── Back-fill: mark all existing city+state combos as already known ─────────
-- Dismissed = true so they don't appear as "new" to the admin.
INSERT INTO public.location_notifications (city, state, property_id, detected_at, dismissed)
SELECT DISTINCT ON (trim(city), upper(trim(state)))
  trim(city),
  upper(trim(state)),
  id,
  now(),
  true
FROM public.properties
WHERE city  IS NOT NULL AND trim(city)  <> ''
  AND state IS NOT NULL AND trim(state) <> ''
ORDER BY trim(city), upper(trim(state)), created_at ASC
ON CONFLICT (city, state) DO NOTHING;
