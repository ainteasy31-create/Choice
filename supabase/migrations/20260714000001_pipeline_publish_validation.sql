-- pipeline_publish v5: add server-side pre-publish validation gate
-- Enforces mandatory platform rules (scraper/PLATFORM_RULES.md) at the
-- database level so every publish path is gated equally, regardless of
-- whether the request originates from the admin UI, a direct RPC call,
-- or any future automation.
--
-- New blocking checks added before the INSERT:
--   1. Source images must be present in original_image_urls (non-empty JSON array).
--      Photos are transferred to ImageKit by import-pipeline-photos immediately
--      after a first publish; the source array is the mandatory pre-publish gate.
--   2. Application fee is always written as 50 into the properties row,
--      overriding whatever the pipeline record holds (hard server-side guarantee).
--   3. Description must not contain free-application language.  Wording that
--      implies a free or $0 fee must have been cleaned by the enrichment pipeline
--      before reaching this function.
--
-- The existing required-field check (title/address/city/state/zip/monthly_rent)
-- is preserved unchanged.

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
  p         pipeline.pipeline_properties%ROWTYPE;
  new_id    text;
  img_count int;
BEGIN
  -- ── Fetch pipeline record ────────────────────────────────────────────────
  SELECT * INTO p FROM pipeline.pipeline_properties WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Listing not found in pipeline');
  END IF;

  -- ── Required field check (pre-existing) ──────────────────────────────────
  IF p.title IS NULL OR p.address IS NULL OR p.city IS NULL
     OR p.state IS NULL OR p.zip IS NULL OR p.monthly_rent IS NULL THEN
    RETURN json_build_object('ok', false, 'error',
      'Missing required fields: title, address, city, state, zip, monthly_rent');
  END IF;

  -- ── Image check ──────────────────────────────────────────────────────────
  -- original_image_urls must be a non-empty JSON array. Photos are transferred
  -- to ImageKit by import-pipeline-photos immediately post-publish; the source
  -- array being populated is the mandatory pre-publish gate.
  IF p.original_image_urls IS NULL
     OR trim(p.original_image_urls) IN ('', '[]', 'null') THEN
    RETURN json_build_object('ok', false, 'error',
      'No source images — add at least one photo before publishing');
  END IF;

  BEGIN
    SELECT jsonb_array_length(p.original_image_urls::jsonb) INTO img_count;
  EXCEPTION WHEN OTHERS THEN
    img_count := 0;
  END;
  IF img_count = 0 THEN
    RETURN json_build_object('ok', false, 'error',
      'No source images — add at least one photo before publishing');
  END IF;

  -- ── Free-application language check ──────────────────────────────────────
  -- Block publish if the description still contains wording that implies
  -- the application is free or costs $0. The enrichment pipeline normalises
  -- these before DB insert; this check catches records created outside the
  -- pipeline or edited manually after enrichment.
  IF p.description IS NOT NULL AND p.description ~* (
    'free\s+application'
    '|apply\s+for\s+free'
    '|no\s+application\s+fee'
    '|no\s+app\s+fee'
    '|\$\s*0\.?0*\s+application'
    '|zero\s+application\s+fee'
    '|complimentary\s+application'
    '|application\s+is\s+free'
    '|fee.free\s+application'
    '|free\s+to\s+apply'
  ) THEN
    RETURN json_build_object('ok', false, 'error',
      'Description contains free-application language — clean via enrichment pipeline before publishing');
  END IF;

  -- ── Publish ──────────────────────────────────────────────────────────────
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
    listed_at, source_status
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
    50,  -- application_fee: always $50, enforced unconditionally server-side
    p.pet_deposit, p.admin_fee, p.move_in_special,
    CASE WHEN p.available_date ~ '^\d{4}-\d{2}-\d{2}$'
         THEN p.available_date::date ELSE NULL END,
    p.minimum_lease_months,
    p.pets_allowed, p.pet_details, p.pet_weight_limit, p.smoking_allowed,
    p.parking,
    CASE WHEN p.amenities IS NOT NULL AND p.amenities <> '' AND p.amenities <> '[]'
         THEN ARRAY(SELECT jsonb_array_elements_text(p.amenities::jsonb))
         ELSE NULL END,
    p.location_context, p.virtual_tour_url, p.has_basement, p.has_central_air,
    p.listed_at,
    COALESCE(p.source_status, 'available')
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
