-- Bulk delete pipeline properties (hard delete) — SECURITY DEFINER
CREATE OR REPLACE FUNCTION public.pipeline_bulk_delete(p_ids json)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pipeline
AS $$
DECLARE
  ids text[];
  cnt int := 0;
BEGIN
  IF p_ids IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'No ids provided');
  END IF;
  SELECT array_agg(elem::text) INTO ids
  FROM json_array_elements_text(p_ids) elem;
  IF ids IS NULL OR array_length(ids,1) = 0 THEN
    RETURN json_build_object('ok', false, 'error', 'No ids provided');
  END IF;
  DELETE FROM pipeline.pipeline_properties WHERE id = ANY(ids) RETURNING id INTO ids;
  GET DIAGNOSTICS cnt = ROW_COUNT;
  RETURN json_build_object('ok', true, 'deleted', cnt);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.pipeline_bulk_delete(json) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.pipeline_bulk_delete(json) TO authenticated;
