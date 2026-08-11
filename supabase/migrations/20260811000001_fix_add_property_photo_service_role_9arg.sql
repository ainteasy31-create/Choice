-- Allow the 9-argument photo RPC to be used by trusted server-side imports.
--
-- The 9-argument overload introduced for explicit display_order/is_hero kept
-- the owner check from the browser-only version. The import-pipeline-photos
-- edge function calls it with the service-role client, so auth.uid() is NULL
-- and every insert was rejected even after the ImageKit upload succeeded.

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
  v_owner           BOOLEAN;
  v_admin           BOOLEAN := is_admin();
  v_is_service_role BOOLEAN;
  v_order           INT;
  v_new_id         UUID;
BEGIN
  IF p_property_id IS NULL OR p_url IS NULL THEN
    RAISE EXCEPTION 'property_id and url are required';
  END IF;

  -- Edge functions and batch jobs use the service-role key. In that context
  -- auth.uid() is NULL and current_role is service_role, so the normal
  -- browser ownership check must be bypassed.
  v_is_service_role := (auth.uid() IS NULL AND current_role = 'service_role');

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
    p_alt_text, p_caption, p_width, p_height, 'pending'
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END $$;

GRANT EXECUTE ON FUNCTION public.add_property_photo(TEXT, TEXT, TEXT, TEXT, TEXT, INT, INT, INT, BOOLEAN)
  TO authenticated;