-- Expose photo_import_status / last_photo_import_error via pipeline_list
-- so the admin pipeline UI can show a "Pending images" indicator instead
-- of a listing silently sitting invisible with no explanation.

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
      listed_at, lat, lng,
      source_status, last_verified_at,
      photo_import_status, last_photo_import_error, last_photo_import_at,
      original_data
    FROM pipeline.pipeline_properties
    WHERE (p_status = 'all' OR status = p_status)
    ORDER BY COALESCE(listed_at, scraped_at::date) DESC NULLS LAST
    LIMIT p_limit OFFSET p_offset
  ) t;
  RETURN COALESCE(result, '[]'::json);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.pipeline_list(text,int,int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.pipeline_list(text,int,int) TO authenticated;
