-- pipeline_publish v6: full server-side pre-publish validation gate
-- Enforces mandatory platform rules (scraper/PLATFORM_RULES.md) at the
-- database level so every publish path is gated equally, regardless of
-- whether the request originates from the admin UI, a direct RPC call,
-- or any future automation.
--
-- Validation checks (all applied before the INSERT):
--   1. Required fields: title, address, city, state, zip, monthly_rent
--   2. Two-tier image rule:
--      a. Re-publish (choice_property_id IS NOT NULL): property_photos count > 0
--      b. First publish: original_image_urls must be a non-empty JSON array
--   3. Free-application language in description (regex)
--   4. Non-$50 application fee amount in description (both "fee: $35" and
--      "$35 application fee" style patterns)
--   5. Tour / showing / contact CTA language in description
--   6. External portal references in description
--   7. application_fee is always written as 50 in the INSERT row
--      (normalised unconditionally; not a blocking check)

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
  p            pipeline.pipeline_properties%ROWTYPE;
  new_id       text;
  img_count    int;
  photo_count  bigint;
  amt_val      numeric;
  fee_match    text;
BEGIN
  -- ── Fetch pipeline record ────────────────────────────────────────────────
  SELECT * INTO p FROM pipeline.pipeline_properties WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Listing not found in pipeline');
  END IF;

  -- ── 1. Required fields ───────────────────────────────────────────────────
  IF p.title IS NULL OR p.address IS NULL OR p.city IS NULL
     OR p.state IS NULL OR p.zip IS NULL OR p.monthly_rent IS NULL THEN
    RETURN json_build_object('ok', false, 'error',
      'Missing required fields: title, address, city, state, zip, monthly_rent');
  END IF;

  -- ── 2. Two-tier image rule ───────────────────────────────────────────────
  IF p.choice_property_id IS NOT NULL THEN
    -- Re-publish path: confirm ImageKit photos exist in property_photos
    SELECT count(*) INTO photo_count
    FROM public.property_photos
    WHERE property_id = p.choice_property_id;

    IF photo_count = 0 THEN
      RETURN json_build_object('ok', false, 'error',
        'No images have been transferred to ImageKit — use "Import source photos" before re-publishing');
    END IF;
  ELSE
    -- First publish: source images must be present (transferred post-publish)
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
  END IF;

  -- ── 3. Free-application language ─────────────────────────────────────────
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

  -- ── 4. Non-$50 fee amount in description ─────────────────────────────────
  -- Catches both trailing-dollar style ("application fee: $35") AND
  -- leading-dollar style ("$35 application fee").
  IF p.description IS NOT NULL THEN
    -- trailing-dollar: "application fee: $35" or "application fee 40"
    SELECT (regexp_matches(p.description,
        '(?:application|app)\s+fee[:\s]+\$?\s*(\d+(?:\.\d{2})?)',
        'ig'))[1] INTO fee_match;
    IF fee_match IS NOT NULL THEN
      BEGIN amt_val := fee_match::numeric; EXCEPTION WHEN OTHERS THEN amt_val := 50; END;
      IF abs(amt_val - 50) > 0.01 THEN
        RETURN json_build_object('ok', false, 'error',
          'Description references a non-$50 application fee ($' || fee_match || ') — fix before publishing');
      END IF;
    END IF;

    -- leading-dollar: "$35 application fee" or "a $40 app fee"
    SELECT (regexp_matches(p.description,
        '\$\s*(\d+(?:\.\d{2})?)\s+(?:application|app)\s+fee',
        'ig'))[1] INTO fee_match;
    IF fee_match IS NOT NULL THEN
      BEGIN amt_val := fee_match::numeric; EXCEPTION WHEN OTHERS THEN amt_val := 50; END;
      IF abs(amt_val - 50) > 0.01 THEN
        RETURN json_build_object('ok', false, 'error',
          'Description references a non-$50 application fee ($' || fee_match || ') — fix before publishing');
      END IF;
    END IF;
  END IF;

  -- ── 5. Tour / showing / contact CTA language ─────────────────────────────
  IF p.description IS NOT NULL AND p.description ~* (
    'schedule\s+a\s+(?:tour|showing|viewing)'
    '|book\s+a\s+(?:tour|showing)'
    '|open\s+house'
    '|contact\s+(?:us|the\s+agent|the\s+landlord|owner)'
  ) THEN
    RETURN json_build_object('ok', false, 'error',
      'Description contains tour/showing/contact CTA language — remove before publishing');
  END IF;

  -- ── 6. External portal references ────────────────────────────────────────
  IF p.description IS NOT NULL AND p.description ~* (
    'turbotenant'
    '|zillow\s+application'
    '|apartments\.com'
    '|apply\s+on\s+\w+'
    '|listing\s*id\s*#?\s*\d+'
  ) THEN
    RETURN json_build_object('ok', false, 'error',
      'Description references an external application portal — remove before publishing');
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
