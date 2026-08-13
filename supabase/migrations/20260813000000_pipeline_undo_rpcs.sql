-- Undo RPCs for pipeline admin actions
-- These support the undo toast system in admin/pipeline.js

-- ── pipeline_unarchive ────────────────────────────────────────────────────────
-- Restore an archived listing to its previous status (default: scraped).
CREATE OR REPLACE FUNCTION public.pipeline_unarchive(
  p_id text,
  p_status text DEFAULT 'scraped'
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pipeline
AS $$
BEGIN
  UPDATE pipeline.pipeline_properties
  SET status = p_status, updated_at = now()
  WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Not found');
  END IF;
  RETURN json_build_object('ok', true);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.pipeline_unarchive(text,text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.pipeline_unarchive(text,text) TO authenticated;

-- ── pipeline_restore ──────────────────────────────────────────────────────────
-- Re-insert a hard-deleted pipeline record (undo delete).
-- Resets choice_property_id and published_at to avoid dangling references.
CREATE OR REPLACE FUNCTION public.pipeline_restore(
  p_payload jsonb
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pipeline
AS $$
DECLARE
  v_id text;
BEGIN
  v_id = p_payload->>'id';
  IF v_id IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'Missing id');
  END IF;

  INSERT INTO pipeline.pipeline_properties (
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
    neighborhood, county, location_context
  ) VALUES (
    v_id,
    COALESCE(p_payload->>'status', 'scraped'),
    p_payload->>'title', p_payload->>'address', p_payload->>'city', p_payload->>'state', p_payload->>'zip',
    (p_payload->>'bedrooms')::int, (p_payload->>'bathrooms')::float, (p_payload->>'square_footage')::int, (p_payload->>'monthly_rent')::int,
    p_payload->>'property_type', (p_payload->>'year_built')::int, p_payload->>'unit_number',
    p_payload->>'description', p_payload->>'showing_instructions',
    (p_payload->>'pets_allowed')::boolean, (p_payload->>'smoking_allowed')::boolean, p_payload->>'parking',
    (p_payload->>'minimum_lease_months')::int, (p_payload->>'security_deposit')::int, (p_payload->>'application_fee')::int,
    (p_payload->>'garage_spaces')::int, p_payload->>'available_date', p_payload->>'virtual_tour_url',
    (p_payload->>'has_basement')::boolean, (p_payload->>'has_central_air')::boolean,
    COALESCE((p_payload->>'data_quality_score')::int, 0), p_payload->>'missing_fields', p_payload->>'edited_fields',
    p_payload->>'original_image_urls', p_payload->>'source_url', p_payload->>'source', p_payload->>'agent_name',
    p_payload->>'poster_landlord_id', NULL,
    COALESCE(p_payload->>'scraped_at', now()::text), now()::text, NULL,
    p_payload->>'neighborhood', p_payload->>'county', p_payload->>'location_context'
  )
  ON CONFLICT (id) DO UPDATE SET
    status = EXCLUDED.status,
    updated_at = now();

  RETURN json_build_object('ok', true, 'id', v_id);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.pipeline_restore(jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.pipeline_restore(jsonb) TO authenticated;

-- ── pipeline_unpublish ────────────────────────────────────────────────────────
-- Revert a published listing back to edited, clearing the live property reference.
CREATE OR REPLACE FUNCTION public.pipeline_unpublish(
  p_id text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pipeline
AS $$
BEGIN
  UPDATE pipeline.pipeline_properties
  SET status = 'edited',
      choice_property_id = NULL,
      published_at = NULL,
      updated_at = now()
  WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Not found');
  END IF;
  RETURN json_build_object('ok', true);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.pipeline_unpublish(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.pipeline_unpublish(text) TO authenticated;
