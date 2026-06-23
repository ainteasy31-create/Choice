-- ============================================================
-- listed_at: original source listing date
-- Stores the date the property was first listed on Zillow/Realtor,
-- separate from scraped_at (when we captured it) and
-- created_at (when it was published into our properties table).
-- Used to sort /listings by "Date listed" — most recently listed first.
-- ============================================================

-- 1. Add column to pipeline staging table
ALTER TABLE pipeline.pipeline_properties
  ADD COLUMN IF NOT EXISTS listed_at DATE;

-- 2. Add column to published properties table
ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS listed_at DATE;

-- 3. Backfill existing pipeline records from original_data JSON
--    (Realtor.com scraper stored list_date there before this migration)
UPDATE pipeline.pipeline_properties
SET listed_at = (original_data::jsonb->>'list_date')::date
WHERE listed_at IS NULL
  AND original_data IS NOT NULL
  AND original_data != ''
  AND original_data::jsonb->>'list_date' IS NOT NULL
  AND original_data::jsonb->>'list_date' ~ '^\d{4}-\d{2}-\d{2}';

-- 4. Update pipeline_list RPC — include listed_at, sort by it (nulls last)
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
      listed_at,
      lat, lng
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

-- 5. Update pipeline_publish RPC — copy listed_at into public.properties
CREATE OR REPLACE FUNCTION public.pipeline_publish(
  p_id          text,
  p_landlord_id uuid DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pipeline
AS $$
DECLARE
  p      pipeline.pipeline_properties%ROWTYPE;
  new_id text;
BEGIN
  SELECT * INTO p FROM pipeline.pipeline_properties WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Listing not found in pipeline');
  END IF;
  IF p.title IS NULL OR p.address IS NULL OR p.city IS NULL
     OR p.state IS NULL OR p.zip IS NULL OR p.monthly_rent IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'Missing required fields: title, address, city, state, zip, monthly_rent');
  END IF;

  new_id := gen_random_uuid()::text;

  INSERT INTO public.properties (
    id, landlord_id, status,
    title, description, showing_instructions,
    address, city, state, zip, county, neighborhood,
    lat, lng, property_type, year_built, floors,
    unit_number, total_units,
    bedrooms, bathrooms, half_bathrooms, square_footage,
    lot_size_sqft, garage_spaces,
    monthly_rent, security_deposit, last_months_rent,
    application_fee, pet_deposit, admin_fee, move_in_special,
    available_date, minimum_lease_months,
    pets_allowed, pet_details, pet_weight_limit, smoking_allowed,
    parking, amenities,
    location_context, virtual_tour_url, has_basement, has_central_air,
    listed_at
  ) VALUES (
    new_id,
    COALESCE(p_landlord_id, p.poster_landlord_id::uuid),
    'draft',
    p.title, p.description, p.showing_instructions,
    p.address, p.city, p.state, p.zip, p.county, p.neighborhood,
    p.lat, p.lng,
    p.property_type, p.year_built, p.floors,
    p.unit_number, p.total_units,
    p.bedrooms, p.bathrooms, p.half_bathrooms, p.square_footage,
    p.lot_size_sqft, p.garage_spaces,
    p.monthly_rent, p.security_deposit, p.last_months_rent,
    p.application_fee, p.pet_deposit, p.admin_fee, p.move_in_special,
    CASE WHEN p.available_date ~ '^\d{4}-\d{2}-\d{2}$'
         THEN p.available_date::date ELSE NULL END,
    p.minimum_lease_months,
    p.pets_allowed, p.pet_details, p.pet_weight_limit, p.smoking_allowed,
    p.parking,
    CASE WHEN p.amenities IS NOT NULL AND p.amenities != '[]'
         THEN p.amenities::jsonb ELSE NULL END,
    p.location_context, p.virtual_tour_url, p.has_basement, p.has_central_air,
    p.listed_at
  );

  UPDATE pipeline.pipeline_properties
  SET status             = 'published',
      choice_property_id = new_id,
      published_at       = now()::text,
      updated_at         = now()
  WHERE id = p_id;

  RETURN json_build_object('ok', true, 'choice_property_id', new_id);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.pipeline_publish(text,uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.pipeline_publish(text,uuid) TO authenticated;
