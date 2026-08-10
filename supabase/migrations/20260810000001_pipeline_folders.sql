-- ============================================================
-- Pipeline Folders + ImageKit Cleanup Strategy
-- ============================================================
-- Adds folder/room system to pipeline_properties so properties
-- can be grouped, numbered, and managed as a unit.
-- Also adds ImageKit cleanup triggers to keep storage lean.
-- ============================================================

-- ── 1. Create pipeline_folders table ─────────────────────────────
CREATE TABLE IF NOT EXISTS pipeline.pipeline_folders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- ── 2. Add folder columns to pipeline_properties ─────────────────
ALTER TABLE pipeline.pipeline_properties
  ADD COLUMN IF NOT EXISTS folder_id    UUID REFERENCES pipeline.pipeline_folders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS folder_serial INTEGER;

-- Index for fast folder lookups
CREATE INDEX IF NOT EXISTS idx_pipeline_properties_folder
  ON pipeline.pipeline_properties(folder_id, folder_serial);

-- ── 3. RPC: pipeline_folder_create ───────────────────────────────
CREATE OR REPLACE FUNCTION public.pipeline_folder_create(
  p_name        text,
  p_description text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pipeline
AS $$
DECLARE
  v_id uuid;
BEGIN
  -- Normalize name: trim, collapse spaces, title-case
  p_name := initcap(trim(regexp_replace(p_name, '\s+', ' ', 'g')));
  IF p_name = '' THEN
    RETURN json_build_object('ok', false, 'error', 'Folder name is required');
  END IF;

  -- Check for existing folder with same name
  SELECT id INTO v_id FROM pipeline.pipeline_folders WHERE name = p_name;
  IF FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Folder already exists', 'id', v_id);
  END IF;

  INSERT INTO pipeline.pipeline_folders (name, description)
  VALUES (p_name, p_description)
  RETURNING id INTO v_id;

  RETURN json_build_object('ok', true, 'id', v_id, 'name', p_name);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.pipeline_folder_create(text,text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.pipeline_folder_create(text,text) TO authenticated;

-- ── 4. RPC: pipeline_folder_list ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.pipeline_folder_list()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pipeline
AS $$
DECLARE result json;
BEGIN
  SELECT json_agg(row_to_json(t))
  INTO result
  FROM (
    SELECT
      f.id, f.name, f.description, f.created_at,
      COUNT(p.id) AS property_count,
      COUNT(p.id) FILTER (WHERE p.status = 'published') AS published_count,
      COUNT(p.id) FILTER (WHERE p.status = 'archived') AS archived_count
    FROM pipeline.pipeline_folders f
    LEFT JOIN pipeline.pipeline_properties p ON p.folder_id = f.id
    GROUP BY f.id, f.name, f.description, f.created_at
    ORDER BY f.created_at DESC
  ) t;
  RETURN COALESCE(result, '[]'::json);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.pipeline_folder_list() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.pipeline_folder_list() TO authenticated;

-- ── 5. RPC: pipeline_folder_properties ───────────────────────────
CREATE OR REPLACE FUNCTION public.pipeline_folder_properties(
  p_folder_id uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pipeline
AS $$
DECLARE result json;
BEGIN
  SELECT json_agg(row_to_json(t))
  INTO result
  FROM (
    SELECT
      id, status, title, address, city, state, zip,
      bedrooms, bathrooms, square_footage, monthly_rent,
      property_type, year_built, unit_number,
      description, showing_instructions,
      pets_allowed, smoking_allowed, parking,
      minimum_lease_months, security_deposit, application_fee,
      garage_spaces, available_date, virtual_tour_url,
      has_basement, has_central_air,
      data_quality_score, missing_fields, edited_fields,
      original_image_urls, source_url, source, agent_name,
      poster_landlord_id, choice_property_id,
      scraped_at, updated_at, published_at,
      neighborhood, county, location_context,
      folder_id, folder_serial
    FROM pipeline.pipeline_properties
    WHERE folder_id = p_folder_id
    ORDER BY folder_serial ASC
  ) t;
  RETURN COALESCE(result, '[]'::json);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.pipeline_folder_properties(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.pipeline_folder_properties(uuid) TO authenticated;

-- ── 6. RPC: pipeline_folder_add_property ─────────────────────────
-- Adds a property to a folder by folder name (or ID).
-- Auto-assigns the next serial number based on existing count.
CREATE OR REPLACE FUNCTION public.pipeline_folder_add_property(
  p_property_id text,
  p_folder_name text DEFAULT NULL,
  p_folder_id   uuid   DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pipeline
AS $$
DECLARE
  v_folder_id uuid;
  v_serial    int;
  v_exists    boolean;
BEGIN
  -- Resolve folder by name or ID
  IF p_folder_id IS NULL AND p_folder_name IS NOT NULL THEN
    SELECT id INTO v_folder_id
    FROM pipeline.pipeline_folders
    WHERE name = initcap(trim(regexp_replace(p_folder_name, '\s+', ' ', 'g')));
    IF NOT FOUND THEN
      RETURN json_build_object('ok', false, 'error', 'Folder not found: ' || p_folder_name);
    END IF;
  ELSIF p_folder_id IS NOT NULL THEN
    v_folder_id := p_folder_id;
  ELSE
    RETURN json_build_object('ok', false, 'error', 'Either folder_name or folder_id is required');
  END IF;

  -- Check property exists
  SELECT EXISTS(SELECT 1 FROM pipeline.pipeline_properties WHERE id = p_property_id)
  INTO v_exists;
  IF NOT v_exists THEN
    RETURN json_build_object('ok', false, 'error', 'Property not found');
  END IF;

  -- Auto-assign serial: count existing + 1
  SELECT COALESCE(MAX(folder_serial), 0) + 1
  INTO v_serial
  FROM pipeline.pipeline_properties
  WHERE folder_id = v_folder_id;

  UPDATE pipeline.pipeline_properties
  SET folder_id = v_folder_id,
      folder_serial = v_serial,
      updated_at = now()
  WHERE id = p_property_id;

  RETURN json_build_object('ok', true, 'folder_id', v_folder_id, 'serial', v_serial);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.pipeline_folder_add_property(text,text,uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.pipeline_folder_add_property(text,text,uuid) TO authenticated;

-- ── 7. RPC: pipeline_folder_remove_property ──────────────────────
CREATE OR REPLACE FUNCTION public.pipeline_folder_remove_property(
  p_property_id text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pipeline
AS $$
BEGIN
  UPDATE pipeline.pipeline_properties
  SET folder_id = NULL,
      folder_serial = NULL,
      updated_at = now()
  WHERE id = p_property_id;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Property not found');
  END IF;

  RETURN json_build_object('ok', true);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.pipeline_folder_remove_property(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.pipeline_folder_remove_property(text) TO authenticated;

-- ── 8. RPC: pipeline_folder_publish ──────────────────────────────
-- Publishes all (or selected) properties in a folder.
-- Returns count of successfully published.
CREATE OR REPLACE FUNCTION public.pipeline_folder_publish(
  p_folder_id   uuid,
  p_property_ids text[] DEFAULT NULL  -- NULL = publish all in folder
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pipeline
AS $$
DECLARE
  v_pub_count int := 0;
  v_fail_count int := 0;
  v_errors text[] := '{}';
  v_rec RECORD;
  v_result json;
BEGIN
  FOR v_rec IN
    SELECT id FROM pipeline.pipeline_properties
    WHERE folder_id = p_folder_id
      AND status NOT IN ('published', 'archived')
      AND (p_property_ids IS NULL OR id = ANY(p_property_ids))
    ORDER BY folder_serial
  LOOP
    -- Call the existing pipeline_publish RPC for each property
    SELECT result INTO v_result
    FROM public.pipeline_publish(v_rec.id, NULL);

    IF (v_result->>'ok')::boolean THEN
      v_pub_count := v_pub_count + 1;
    ELSE
      v_fail_count := v_fail_count + 1;
      v_errors := array_append(v_errors, v_rec.id || ': ' || COALESCE(v_result->>'error', 'unknown'));
    END IF;
  END LOOP;

  RETURN json_build_object(
    'ok', true,
    'published', v_pub_count,
    'failed', v_fail_count,
    'errors', to_json(v_errors)
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.pipeline_folder_publish(uuid,text[]) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.pipeline_folder_publish(uuid,text[]) TO authenticated;

-- ── 9. RPC: pipeline_folder_delete ───────────────────────────────
-- Deletes a folder. Properties are archived (not deleted) to keep
-- data safe. ImageKit photos are NOT deleted — they stay with the
-- archived property for potential re-publish.
CREATE OR REPLACE FUNCTION public.pipeline_folder_delete(
  p_folder_id uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pipeline
AS $$
DECLARE
  v_name text;
  v_archived int;
BEGIN
  SELECT name INTO v_name FROM pipeline.pipeline_folders WHERE id = p_folder_id;
  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Folder not found');
  END IF;

  -- Archive all non-published properties in the folder
  UPDATE pipeline.pipeline_properties
  SET status = 'archived',
      folder_id = NULL,
      folder_serial = NULL,
      updated_at = now()
  WHERE folder_id = p_folder_id
    AND status NOT IN ('published', 'archived');

  GET DIAGNOSTICS v_archived = ROW_COUNT;

  -- For published properties, just remove folder assignment
  UPDATE pipeline.pipeline_properties
  SET folder_id = NULL,
      folder_serial = NULL,
      updated_at = now()
  WHERE folder_id = p_folder_id;

  DELETE FROM pipeline.pipeline_folders WHERE id = p_folder_id;

  RETURN json_build_object(
    'ok', true,
    'name', v_name,
    'archived', v_archived
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.pipeline_folder_delete(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.pipeline_folder_delete(uuid) TO authenticated;

-- ── 10. RPC: pipeline_folder_rename ──────────────────────────────
CREATE OR REPLACE FUNCTION public.pipeline_folder_rename(
  p_folder_id uuid,
  p_new_name  text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pipeline
AS $$
BEGIN
  p_new_name := initcap(trim(regexp_replace(p_new_name, '\s+', ' ', 'g')));
  IF p_new_name = '' THEN
    RETURN json_build_object('ok', false, 'error', 'Folder name is required');
  END IF;

  UPDATE pipeline.pipeline_folders
  SET name = p_new_name, updated_at = now()
  WHERE id = p_folder_id;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Folder not found');
  END IF;

  RETURN json_build_object('ok', true, 'name', p_new_name);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.pipeline_folder_rename(uuid,text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.pipeline_folder_rename(uuid,text) TO authenticated;

-- ── 11. RPC: pipeline_folder_stats ───────────────────────────────
-- Returns stats for a single folder (for AI commands).
CREATE OR REPLACE FUNCTION public.pipeline_folder_stats(
  p_folder_name text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pipeline
AS $$
DECLARE result json;
BEGIN
  SELECT json_build_object(
    'name', f.name,
    'description', f.description,
    'total', COUNT(p.id),
    'published', COUNT(p.id) FILTER (WHERE p.status = 'published'),
    'scraped', COUNT(p.id) FILTER (WHERE p.status = 'scraped'),
    'edited', COUNT(p.id) FILTER (WHERE p.status = 'edited'),
    'archived', COUNT(p.id) FILTER (WHERE p.status = 'archived'),
    'properties', COALESCE(json_agg(json_build_object(
      'serial', p.folder_serial,
      'id', p.id,
      'address', p.address,
      'city', p.city,
      'rent', p.monthly_rent,
      'status', p.status
    ) ORDER BY p.folder_serial), '[]'::json)
  )
  INTO result
  FROM pipeline.pipeline_folders f
  LEFT JOIN pipeline.pipeline_properties p ON p.folder_id = f.id
  WHERE f.name = initcap(trim(regexp_replace(p_folder_name, '\s+', ' ', 'g')))
  GROUP BY f.name, f.description;

  IF result IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'Folder not found: ' || p_folder_name);
  END IF;

  RETURN json_build_object('ok', true, 'folder', result);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.pipeline_folder_stats(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.pipeline_folder_stats(text) TO authenticated;

-- ── 12. ImageKit Cleanup Strategy ────────────────────────────────
-- When a pipeline property is archived, we mark its photos for cleanup.
-- The actual ImageKit deletion is handled by the edge function
-- (imagekit-delete) which is called from the admin UI.
-- This trigger just tracks the cleanup state.

ALTER TABLE pipeline.pipeline_properties
  ADD COLUMN IF NOT EXISTS photo_cleanup_status TEXT DEFAULT 'none'
    CHECK (photo_cleanup_status IN ('none', 'pending', 'cleaned', 'failed'));

-- ── 13. Update pipeline_list to include folder info ──────────────
CREATE OR REPLACE FUNCTION public.pipeline_list(
  p_status text DEFAULT 'scraped',
  p_limit  int  DEFAULT 50,
  p_offset int  DEFAULT 0
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pipeline
AS $$
DECLARE result json;
BEGIN
  SELECT json_agg(row_to_json(t))
  INTO result
  FROM (
    SELECT
      id, status, title, address, city, state, zip,
      bedrooms, bathrooms, square_footage, monthly_rent,
      property_type, year_built, unit_number,
      description, showing_instructions,
      pets_allowed, smoking_allowed, parking,
      minimum_lease_months, security_deposit, application_fee,
      garage_spaces, available_date, virtual_tour_url,
      has_basement, has_central_air,
      data_quality_score, missing_fields, edited_fields,
      original_image_urls, source_url, source, agent_name,
      poster_landlord_id, choice_property_id,
      scraped_at, updated_at, published_at,
      neighborhood, county, location_context,
      folder_id, folder_serial,
      photo_cleanup_status
    FROM pipeline.pipeline_properties
    WHERE (p_status = 'all' OR status = p_status)
    ORDER BY updated_at DESC
    LIMIT p_limit OFFSET p_offset
  ) t;
  RETURN COALESCE(result, '[]'::json);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.pipeline_list(text,int,int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.pipeline_list(text,int,int) TO authenticated;

-- ── 14. Update pipeline_count to include folder counts ───────────
CREATE OR REPLACE FUNCTION public.pipeline_count()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pipeline
AS $$
DECLARE result json;
BEGIN
  SELECT json_object_agg(status, cnt)
  INTO result
  FROM (
    SELECT status, COUNT(*) AS cnt
    FROM pipeline.pipeline_properties
    GROUP BY status
  ) s;
  RETURN COALESCE(result, '{}'::json);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.pipeline_count() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.pipeline_count() TO authenticated;