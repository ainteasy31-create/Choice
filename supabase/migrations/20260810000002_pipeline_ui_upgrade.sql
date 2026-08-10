-- ============================================================
-- Pipeline UI + Publish Validation Upgrade
-- ============================================================
-- 1. Update pipeline_list to include photo_import_status and
--    last_photo_import_error so the admin UI can show photo state
-- 2. Update pipeline_folder_properties similarly
-- 3. Add pipeline_photo_gallery RPC for fetching all photos
-- ============================================================

-- ── 1. Update pipeline_list to include photo status fields ─────
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
      photo_cleanup_status,
      photo_import_status,
      last_photo_import_error,
      last_photo_import_at
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

-- ── 2. Update pipeline_folder_properties to include photo status ─
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
      photo_cleanup_status,
      photo_import_status,
      last_photo_import_error,
      last_photo_import_at
    FROM pipeline.pipeline_properties
    WHERE folder_id = p_folder_id
    ORDER BY folder_serial ASC
  ) t;
  RETURN COALESCE(result, '[]'::json);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.pipeline_folder_properties(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.pipeline_folder_properties(uuid) TO authenticated;

-- ── 3. Add pipeline_photo_gallery RPC ──────────────────────────
-- Returns all photos for a pipeline property (for gallery view)
CREATE OR REPLACE FUNCTION public.pipeline_photo_gallery(
  p_id text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pipeline
AS $$
DECLARE result json;
BEGIN
  SELECT json_build_object(
    'id', p.id,
    'title', p.title,
    'address', p.address,
    'city', p.city,
    'state', p.state,
    'zip', p.zip,
    'monthly_rent', p.monthly_rent,
    'bedrooms', p.bedrooms,
    'bathrooms', p.bathrooms,
    'square_footage', p.square_footage,
    'property_type', p.property_type,
    'description', p.description,
    'photos', COALESCE(p.original_image_urls::json, '[]'::json),
    'photo_import_status', p.photo_import_status,
    'source', p.source,
    'source_url', p.source_url
  )
  INTO result
  FROM pipeline.pipeline_properties p
  WHERE p.id = p_id;

  IF result IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'Property not found');
  END IF;

  RETURN json_build_object('ok', true, 'property', result);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.pipeline_photo_gallery(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.pipeline_photo_gallery(text) TO authenticated;