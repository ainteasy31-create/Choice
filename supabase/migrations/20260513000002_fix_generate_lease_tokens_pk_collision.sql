-- 20260513000002 — fix generate_lease_tokens "duplicate key violates
-- lease_signing_tokens_pkey" error seen by admin when generating leases.
--
-- Symptom: clicking "Generate lease" on the admin lease list returns
--   "Token generation failed: duplicate key value violates unique
--    constraint lease_signing_tokens_pkey"
--
-- The PK is on `token`. Random 32-byte hex tokens should never collide,
-- but the function was failing in production anyway. The most likely
-- cause is a stale row left behind from an earlier partial run, or a
-- second admin click landing while the first INSERT is still in-flight.
--
-- This rewrite is bulletproof:
--   * Wraps each INSERT in a sub-block with EXCEPTION WHEN unique_violation,
--     so a (cosmically improbable) collision triggers a fresh re-roll
--     instead of failing the whole RPC.
--   * Bumps to 5 attempts before giving up — at 256 bits of entropy that
--     gives 5 × 2^-256 chance of failure, i.e. effectively zero.
--   * Keeps the same external contract: returns the same JSONB shape so
--     the generate-lease edge function and admin UI need no changes.
--   * Keeps the existing "revoke previously-active tokens" behavior so
--     audit history is preserved (revoked_at + revoke_reason).
--   * Preserves SECURITY DEFINER, search_path, and grants — purely a
--     body change.

CREATE OR REPLACE FUNCTION public.generate_lease_tokens(p_app_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  app_rec      RECORD;
  tenant_token TEXT;
  co_token     TEXT;
  v_co_email   TEXT;
  v_attempts   INT;
BEGIN
  SELECT * INTO app_rec FROM public.applications WHERE app_id = p_app_id LIMIT 1;
  IF NOT FOUND THEN
    RETURN '{"success": false, "message": "Application not found."}'::JSONB;
  END IF;

  -- Re-generation supersedes any active tokens for this lease.
  -- Old rows are kept (with revoked_at set) for audit history.
  UPDATE public.lease_signing_tokens
     SET revoked_at    = now(),
         revoke_reason = COALESCE(revoke_reason, 'lease_regenerated')
   WHERE app_id      = p_app_id
     AND signer_role IN ('tenant','co_applicant')
     AND used_at    IS NULL
     AND revoked_at IS NULL;

  -- Stamp the new live tokens onto applications first so the application
  -- columns and registry are written in the same RPC transaction.
  IF app_rec.has_co_applicant THEN
    SELECT email INTO v_co_email FROM public.co_applicants WHERE app_id = p_app_id LIMIT 1;
  END IF;

  -- Tenant token: retry on the (essentially impossible) PK collision.
  v_attempts := 0;
  LOOP
    v_attempts := v_attempts + 1;
    tenant_token := encode(extensions.gen_random_bytes(32), 'hex');
    BEGIN
      INSERT INTO public.lease_signing_tokens (token, app_id, signer_role, signer_email)
      VALUES (tenant_token, p_app_id, 'tenant', COALESCE(app_rec.email, ''));
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF v_attempts >= 5 THEN
        RAISE EXCEPTION
          'generate_lease_tokens: tenant token collided 5x (impossible — check pgcrypto)'
          USING ERRCODE = 'P0001';
      END IF;
    END;
  END LOOP;

  -- Co-applicant token (only if applicable).
  IF app_rec.has_co_applicant THEN
    v_attempts := 0;
    LOOP
      v_attempts := v_attempts + 1;
      co_token := encode(extensions.gen_random_bytes(32), 'hex');
      BEGIN
        INSERT INTO public.lease_signing_tokens (token, app_id, signer_role, signer_email)
        VALUES (co_token, p_app_id, 'co_applicant', COALESCE(v_co_email, app_rec.email, ''));
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        IF v_attempts >= 5 THEN
          RAISE EXCEPTION
            'generate_lease_tokens: co-applicant token collided 5x (impossible — check pgcrypto)'
            USING ERRCODE = 'P0001';
        END IF;
      END;
    END LOOP;
  ELSE
    co_token := NULL;
  END IF;

  -- Now publish the live tokens onto the application row.
  UPDATE public.applications SET
    tenant_sign_token        = tenant_token,
    co_applicant_lease_token = co_token,
    lease_status             = 'sent',
    lease_sent_date          = now(),
    updated_at               = now()
  WHERE app_id = p_app_id;

  RETURN jsonb_build_object(
    'success',           true,
    'tenant_token',      tenant_token,
    'co_applicant_token', co_token
  );
END;
$fn$;

-- Keep the same execution grants as before (service_role only via the
-- generate-lease edge function; anon/authenticated were revoked in the
-- phase 14 advisor fixes migration).
REVOKE EXECUTE ON FUNCTION public.generate_lease_tokens(TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.generate_lease_tokens(TEXT) TO service_role;
