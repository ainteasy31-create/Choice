-- ============================================================
-- Add move_in_special to pipeline_list and pipeline_save RPCs
-- pipeline_publish already includes it; this closes the gap.
-- ============================================================

-- ── pipeline_list ───────────────────────────────────────────────────────────
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
      description, showing_instructions, move_in_special,
      pets_allowed, smoking_allowed, parking,
      minimum_lease_months, security_deposit, application_fee,
      garage_spaces, available_date, virtual_tour_url,
      has_basement, has_central_air,
      data_quality_score, missing_fields, edited_fields,
      original_image_urls, source_url, source, agent_name,
      poster_landlord_id, choice_property_id,
      scraped_at, updated_at, published_at,
      neighborhood, county, location_context
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

-- ── pipeline_save ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pipeline_save(
  p_id    text,
  p_patch jsonb
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pipeline
AS $$
DECLARE
  v_existing pipeline.pipeline_properties%ROWTYPE;
  v_edited   text;
BEGIN
  SELECT * INTO v_existing FROM pipeline.pipeline_properties WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Not found');
  END IF;

  SELECT array_to_json(array_agg(DISTINCT e))::text
  INTO v_edited
  FROM (
    SELECT jsonb_array_elements_text(COALESCE(v_existing.edited_fields::jsonb, '[]'::jsonb)) AS e
    UNION
    SELECT key FROM jsonb_each_text(p_patch)
  ) t(e);

  UPDATE pipeline.pipeline_properties SET
    title                = COALESCE(p_patch->>'title',                title),
    address              = COALESCE(p_patch->>'address',              address),
    city                 = COALESCE(p_patch->>'city',                 city),
    state                = COALESCE(p_patch->>'state',                state),
    zip                  = COALESCE(p_patch->>'zip',                  zip),
    county               = COALESCE(p_patch->>'county',               county),
    neighborhood         = COALESCE(p_patch->>'neighborhood',         neighborhood),
    bedrooms             = COALESCE((p_patch->>'bedrooms')::int,      bedrooms),
    bathrooms            = COALESCE((p_patch->>'bathrooms')::float,   bathrooms),
    square_footage       = COALESCE((p_patch->>'square_footage')::int,square_footage),
    monthly_rent         = COALESCE((p_patch->>'monthly_rent')::int,  monthly_rent),
    security_deposit     = COALESCE((p_patch->>'security_deposit')::int, security_deposit),
    application_fee      = COALESCE((p_patch->>'application_fee')::int,  application_fee),
    property_type        = COALESCE(p_patch->>'property_type',        property_type),
    description          = COALESCE(p_patch->>'description',          description),
    showing_instructions = COALESCE(p_patch->>'showing_instructions', showing_instructions),
    move_in_special      = COALESCE(p_patch->>'move_in_special',      move_in_special),
    available_date       = COALESCE(p_patch->>'available_date',       available_date),
    pets_allowed         = COALESCE((p_patch->>'pets_allowed')::boolean,   pets_allowed),
    smoking_allowed      = COALESCE((p_patch->>'smoking_allowed')::boolean,smoking_allowed),
    minimum_lease_months = COALESCE((p_patch->>'minimum_lease_months')::int, minimum_lease_months),
    garage_spaces        = COALESCE((p_patch->>'garage_spaces')::int, garage_spaces),
    virtual_tour_url     = COALESCE(p_patch->>'virtual_tour_url',     virtual_tour_url),
    has_basement         = COALESCE((p_patch->>'has_basement')::boolean,   has_basement),
    has_central_air      = COALESCE((p_patch->>'has_central_air')::boolean,has_central_air),
    poster_landlord_id   = COALESCE(p_patch->>'poster_landlord_id',   poster_landlord_id),
    location_context     = COALESCE(p_patch->>'location_context',     location_context),
    edited_fields        = COALESCE(v_edited, '[]'),
    status               = CASE WHEN status = 'scraped' THEN 'edited' ELSE status END,
    updated_at           = now()
  WHERE id = p_id;

  RETURN json_build_object('ok', true);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.pipeline_save(text,jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.pipeline_save(text,jsonb) TO authenticated;
