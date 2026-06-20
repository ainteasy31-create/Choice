-- ============================================================
-- pipeline_stats() — public RPC that reads pipeline.pipeline_properties
-- Callable by authenticated role (admin dashboard only).
-- SECURITY DEFINER runs as owner (postgres) which has access to the
-- private pipeline schema. The calling user must be authenticated.
-- ============================================================

CREATE OR REPLACE FUNCTION public.pipeline_stats()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pipeline
AS $$
DECLARE
  result json;
BEGIN
  SELECT json_build_object(
    'scraped',   COALESCE(SUM(CASE WHEN status = 'scraped'   THEN 1 ELSE 0 END), 0),
    'edited',    COALESCE(SUM(CASE WHEN status = 'edited'    THEN 1 ELSE 0 END), 0),
    'published', COALESCE(SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END), 0),
    'archived',  COALESCE(SUM(CASE WHEN status = 'archived'  THEN 1 ELSE 0 END), 0),
    'total',     COUNT(*)
  ) INTO result
  FROM pipeline.pipeline_properties;

  RETURN result;
END;
$$;

-- Only authenticated users (admins) can call this.
-- Anon users cannot reach admin pages so this is a belt-and-suspenders grant.
REVOKE EXECUTE ON FUNCTION public.pipeline_stats() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.pipeline_stats() TO authenticated;

COMMENT ON FUNCTION public.pipeline_stats() IS
  'Returns scrape pipeline property counts grouped by status. '
  'SECURITY DEFINER — accesses private pipeline schema. Admin dashboard only.';
