-- Create pipeline_publish_and_delete: publish then remove pipeline row
CREATE OR REPLACE FUNCTION public.pipeline_publish_and_delete(
  p_id text,
  p_landlord_id uuid DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pipeline
AS $$
DECLARE
  v_result json;
  v_choice_id text;
BEGIN
  -- Call existing publish RPC
  SELECT public.pipeline_publish(p_id, p_landlord_id) INTO v_result;
  IF NOT ((v_result->>'ok')::boolean) THEN
    RETURN v_result;
  END IF;
  v_choice_id := v_result->>'choice_property_id';

  -- Remove the pipeline row to perform a hard-delete
  DELETE FROM pipeline.pipeline_properties WHERE id = p_id;

  RETURN json_build_object('ok', true, 'choice_property_id', v_choice_id, 'deleted', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.pipeline_publish_and_delete(text,uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.pipeline_publish_and_delete(text,uuid) TO authenticated;
