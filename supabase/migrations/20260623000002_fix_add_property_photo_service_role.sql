-- ============================================================
-- MIGRATION: Fix add_property_photo to allow service_role bypass
-- Date: 2026-06-23
-- Root cause: SECURITY INVOKER + auth.uid()=NULL when called
-- with service_role key → is_admin() returns false → ownership
-- check fails for all server-side batch imports.
-- Fix: detect service_role context (auth.uid() IS NULL and
-- current_role = 'service_role') and skip ownership check.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION add_property_photo(
  p_property_id  TEXT,
  p_url          TEXT,
  p_file_id      TEXT,
  p_alt_text     TEXT DEFAULT NULL,
  p_caption      TEXT DEFAULT NULL,
  p_width        INT  DEFAULT NULL,
  p_height       INT  DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_owner          BOOLEAN;
  v_admin          BOOLEAN := is_admin();
  v_is_service_role BOOLEAN;
  v_order          INT;
  v_new_id         UUID;
BEGIN
  IF p_property_id IS NULL OR p_url IS NULL THEN
    RAISE EXCEPTION 'property_id and url are required';
  END IF;

  -- Service role bypass: when called server-side (batch import, edge functions)
  -- auth.uid() is NULL. Allow if current_role is service_role.
  v_is_service_role := (auth.uid() IS NULL AND current_role = 'service_role');

  -- Ownership / admin check (skipped for service_role)
  IF NOT v_is_service_role THEN
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
  END IF;

  -- Next free display_order
  SELECT COALESCE(MAX(display_order), -1) + 1
    INTO v_order
    FROM property_photos
   WHERE property_id = p_property_id;

  INSERT INTO property_photos (
    property_id, url, file_id, display_order,
    alt_text, caption, width, height, watermark_status
  ) VALUES (
    p_property_id, p_url, NULLIF(p_file_id, ''), v_order,
    p_alt_text, p_caption, p_width, p_height, 'pending'
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END $$;

GRANT EXECUTE ON FUNCTION add_property_photo(TEXT, TEXT, TEXT, TEXT, TEXT, INT, INT)
  TO authenticated;

-- Same fix for delete_property_photo_by_file_id
CREATE OR REPLACE FUNCTION delete_property_photo_by_file_id(
  p_file_id TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_pid             TEXT;
  v_owner           BOOLEAN;
  v_admin           BOOLEAN := is_admin();
  v_is_service_role BOOLEAN;
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

  v_is_service_role := (auth.uid() IS NULL AND current_role = 'service_role');

  IF NOT v_is_service_role THEN
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
  END IF;

  DELETE FROM property_photos WHERE file_id = p_file_id;

  WITH ranked AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY display_order) - 1 AS new_order
      FROM property_photos
     WHERE property_id = v_pid
  )
  UPDATE property_photos pp
     SET display_order = ranked.new_order
    FROM ranked
   WHERE pp.id = ranked.id
     AND pp.display_order IS DISTINCT FROM ranked.new_order;

  RETURN TRUE;
END $$;

GRANT EXECUTE ON FUNCTION delete_property_photo_by_file_id(TEXT) TO authenticated;

COMMIT;
