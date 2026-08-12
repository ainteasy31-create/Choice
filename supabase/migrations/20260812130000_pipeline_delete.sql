-- Delete single pipeline property (hard delete) — SECURITY DEFINER
CREATE OR REPLACE FUNCTION public.pipeline_delete(p_id text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pipeline
AS $$
DECLARE cnt int := 0;
BEGIN
  DELETE FROM pipeline.pipeline_properties WHERE id = p_id;
  GET DIAGNOSTICS cnt = ROW_COUNT;
  IF cnt = 0 THEN
    RETURN json_build_object('ok', false, 'error', 'Not found');
  END IF;
  RETURN json_build_object('ok', true, 'deleted', cnt);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.pipeline_delete(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.pipeline_delete(text) TO authenticated;
