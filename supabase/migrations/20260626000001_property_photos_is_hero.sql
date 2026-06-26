-- Add is_hero to property_photos, backfill live data, update all 3 RPCs.
-- is_hero = true marks the display_order=0 photo (hero/card thumbnail).

ALTER TABLE public.property_photos
  ADD COLUMN IF NOT EXISTS is_hero BOOLEAN NOT NULL DEFAULT false;

-- Backfill: every property's display_order=0 photo becomes the hero
UPDATE public.property_photos
SET is_hero = true
WHERE display_order = 0;

-- ── add_property_photo ───────────────────────────────────────────────────
-- Now accepts explicit p_display_order and p_is_hero so the import edge
-- function can pass the scraped sequence directly instead of computing it.
CREATE OR REPLACE FUNCTION public.add_property_photo(
  p_property_id   TEXT,
  p_url           TEXT,
  p_file_id       TEXT,
  p_alt_text      TEXT    DEFAULT NULL,
  p_caption       TEXT    DEFAULT NULL,
  p_width         INT     DEFAULT NULL,
  p_height        INT     DEFAULT NULL,
  p_display_order INT     DEFAULT NULL,
  p_is_hero       BOOLEAN DEFAULT false
) RETURNS UUID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_owner  BOOLEAN;
  v_admin  BOOLEAN := is_admin();
  v_order  INT;
  v_new_id UUID;
BEGIN
  IF p_property_id IS NULL OR p_url IS NULL THEN
    RAISE EXCEPTION 'property_id and url are required';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM properties p
      JOIN landlords  l ON l.id = p.landlord_id
     WHERE p.id = p_property_id
       AND l.user_id = auth.uid()
  ) INTO v_owner;

  IF NOT (v_owner OR v_admin) THEN
    RAISE EXCEPTION 'Forbidden: not the owner of property %', p_property_id;
  END IF;

  IF p_display_order IS NOT NULL THEN
    v_order := p_display_order;
  ELSE
    SELECT COALESCE(MAX(display_order), -1) + 1
      INTO v_order
      FROM property_photos
     WHERE property_id = p_property_id;
  END IF;

  INSERT INTO property_photos (
    property_id, url, file_id, display_order, is_hero,
    alt_text, caption, width, height, watermark_status
  ) VALUES (
    p_property_id, p_url, NULLIF(p_file_id, ''), v_order, p_is_hero,
    p_alt_text, p_caption, p_width, p_height, 'applied'
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END $$;

GRANT EXECUTE ON FUNCTION public.add_property_photo(TEXT, TEXT, TEXT, TEXT, TEXT, INT, INT, INT, BOOLEAN)
  TO authenticated;

-- ── delete_property_photo_by_file_id ────────────────────────────────────
-- After repacking display_order, update is_hero so position 0 is always hero.
CREATE OR REPLACE FUNCTION public.delete_property_photo_by_file_id(
  p_file_id TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_pid    TEXT;
  v_owner  BOOLEAN;
  v_admin  BOOLEAN := is_admin();
BEGIN
  IF p_file_id IS NULL OR p_file_id = '' THEN
    RETURN FALSE;
  END IF;

  SELECT property_id INTO v_pid
    FROM property_photos
   WHERE file_id = p_file_id
   LIMIT 1;

  IF v_pid IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM properties p
      JOIN landlords  l ON l.id = p.landlord_id
     WHERE p.id = v_pid
       AND l.user_id = auth.uid()
  ) INTO v_owner;

  IF NOT (v_owner OR v_admin) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  DELETE FROM property_photos WHERE file_id = p_file_id;

  WITH ranked AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY display_order) - 1 AS new_order
      FROM property_photos
     WHERE property_id = v_pid
  )
  UPDATE property_photos pp
     SET display_order = ranked.new_order,
         is_hero       = (ranked.new_order = 0)
    FROM ranked
   WHERE pp.id = ranked.id
     AND (pp.display_order IS DISTINCT FROM ranked.new_order
          OR pp.is_hero    IS DISTINCT FROM (ranked.new_order = 0));

  RETURN TRUE;
END $$;

GRANT EXECUTE ON FUNCTION public.delete_property_photo_by_file_id(TEXT) TO authenticated;

-- ── reorder_property_photos ──────────────────────────────────────────────
-- After reordering, update is_hero so position 0 is always the hero.
CREATE OR REPLACE FUNCTION public.reorder_property_photos(
  p_property_id TEXT,
  p_file_ids    TEXT[]
) RETURNS INT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_owner   BOOLEAN;
  v_admin   BOOLEAN := is_admin();
  v_count   INT     := 0;
  v_id      TEXT;
  v_order   INT     := 0;
BEGIN
  IF p_property_id IS NULL OR p_file_ids IS NULL THEN
    RAISE EXCEPTION 'property_id and file_ids are required';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM properties p
      JOIN landlords  l ON l.id = p.landlord_id
     WHERE p.id = p_property_id
       AND l.user_id = auth.uid()
  ) INTO v_owner;

  IF NOT (v_owner OR v_admin) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  FOREACH v_id IN ARRAY p_file_ids LOOP
    UPDATE property_photos
       SET display_order = v_order,
           is_hero       = (v_order = 0)
     WHERE property_id = p_property_id
       AND file_id     = v_id;
    IF FOUND THEN v_count := v_count + 1; END IF;
    v_order := v_order + 1;
  END LOOP;

  WITH tail AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY display_order) - 1 + v_order AS new_order
      FROM property_photos
     WHERE property_id = p_property_id
       AND (file_id IS NULL OR NOT (file_id = ANY (p_file_ids)))
  )
  UPDATE property_photos pp
     SET display_order = tail.new_order,
         is_hero       = false
    FROM tail
   WHERE pp.id = tail.id;

  RETURN v_count;
END $$;

GRANT EXECUTE ON FUNCTION public.reorder_property_photos(TEXT, TEXT[]) TO authenticated;
