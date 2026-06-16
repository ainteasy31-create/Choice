-- 20260616000003 — Add 'archived' value to application_status enum
--
-- The 'archived' application status was introduced in the UI layer but the
-- enum type was never extended. This caused Archive button actions to fail
-- with a PostgreSQL cast error at runtime.
--
-- ALTER TYPE ADD VALUE cannot run inside a transaction that also uses the
-- new value, so this migration is kept as a dedicated, standalone step.
-- It is idempotent (IF NOT EXISTS).

ALTER TYPE application_status ADD VALUE IF NOT EXISTS 'archived';
