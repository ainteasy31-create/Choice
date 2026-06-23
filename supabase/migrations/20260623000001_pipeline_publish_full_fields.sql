-- ============================================================
-- pipeline_publish v2: copy amenities, parking, heating_type,
-- cooling_type, laundry_type, appliances, flooring, and
-- utilities_included when publishing a pipeline record to
-- public.properties.
-- ============================================================
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
    location_context, virtual_tour_url, has_basement, has_central_air
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
    p.location_context, p.virtual_tour_url, p.has_basement, p.has_central_air
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
