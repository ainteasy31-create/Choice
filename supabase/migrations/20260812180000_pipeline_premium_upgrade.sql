-- ============================================================
-- Pipeline Premium Upgrade — Folder Colors, Icons, Photo Upload
-- ============================================================
-- Adds color/icon to folders for premium visual organization.
-- Adds photo_upload_status for tracking photo uploads.
-- ============================================================

-- ── 1. Add color + icon to pipeline_folders ─────────────────
ALTER TABLE pipeline.pipeline_folders
  ADD COLUMN IF NOT EXISTS color TEXT DEFAULT '#6366f1',
  ADD COLUMN IF NOT EXISTS icon  TEXT DEFAULT '📁';

-- ── 2. Update pipeline_folder_create to accept color/icon ────
CREATE OR REPLACE FUNCTION public.pipeline_folder_create(
  p_name        text,
  p_description text DEFAULT NULL,
  p_color       text DEFAULT '#6366f1',
  p_icon        text DEFAULT '📁'
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pipeline
AS $$
DECLARE
  v_id uuid;
BEGIN
  p_name := initcap(trim(regexp_replace(p_name, '\s+', ' ', 'g')));
  IF p_name = '' THEN
    RETURN json_build_object('ok', false, 'error', 'Folder name is required');
  END IF;

  SELECT id INTO v_id FROM pipeline.pipeline_folders WHERE name = p_name;
  IF FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Folder already exists', 'id', v_id);
  END IF;

  INSERT INTO pipeline.pipeline_folders (name, description, color, icon)
  VALUES (p_name, p_description, COALESCE(p_color, '#6366f1'), COALESCE(p_icon, '📁'))
  RETURNING id INTO v_id;

  RETURN json_build_object('ok', true, 'id', v_id, 'name', p_name, 'color', p_color, 'icon', p_icon);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.pipeline_folder_create(text,text,text,text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.pipeline_folder_create(text,text,text,text) TO authenticated;

-- ── 3. Update pipeline_folder_list to include color/icon ─────
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
      f.id, f.name, f.description, f.color, f.icon, f.created_at,
      COUNT(p.id) AS property_count,
      COUNT(p.id) FILTER (WHERE p.status = 'published') AS published_count,
      COUNT(p.id) FILTER (WHERE p.status = 'archived') AS archived_count,
      COUNT(p.id) FILTER (WHERE p.status IN ('scraped', 'edited')) AS pending_count
    FROM pipeline.pipeline_folders f
    LEFT JOIN pipeline.pipeline_properties p ON p.folder_id = f.id
    GROUP BY f.id, f.name, f.description, f.color, f.icon, f.created_at
    ORDER BY f.created_at DESC
  ) t;
  RETURN COALESCE(result, '[]'::json);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.pipeline_folder_list() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.pipeline_folder_list() TO authenticated;

-- ── 4. Update pipeline_folder_rename to accept color/icon ────
CREATE OR REPLACE FUNCTION public.pipeline_folder_rename(
  p_folder_id uuid,
  p_new_name  text,
  p_color     text DEFAULT NULL,
  p_icon      text DEFAULT NULL
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
  SET name = p_new_name,
      color = COALESCE(p_color, color),
      icon = COALESCE(p_icon, icon),
      updated_at = now()
  WHERE id = p_folder_id;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Folder not found');
  END IF;

  RETURN json_build_object('ok', true, 'name', p_new_name);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.pipeline_folder_rename(uuid,text,text,text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.pipeline_folder_rename(uuid,text,text,text) TO authenticated;

-- ── 5. Add photo_upload_status column ────────────────────────
ALTER TABLE pipeline.pipeline_properties
  ADD COLUMN IF NOT EXISTS photo_upload_status TEXT DEFAULT 'none'
    CHECK (photo_upload_status IN ('none', 'uploading', 'complete', 'failed'));

-- ── 6. Update pipeline_folder_properties to include new fields ─
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
      folder_id, folder_serial,
      photo_import_status, photo_upload_status
    FROM pipeline.pipeline_properties
    WHERE folder_id = p_folder_id
    ORDER BY folder_serial ASC
  ) t;
  RETURN COALESCE(result, '[]'::json);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.pipeline_folder_properties(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.pipeline_folder_properties(uuid) TO authenticated;

-- ── 7. Update pipeline_list to include photo_upload_status ───
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
      photo_import_status, photo_upload_status
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