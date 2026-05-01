-- Allow null email and contact_name on landlords
  -- Auto-created poster profiles (from scraper agent attribution) may not have
  -- an email address or a personal contact name (business-only landlords).
  ALTER TABLE public.landlords
    ALTER COLUMN email DROP NOT NULL,
    ALTER COLUMN contact_name DROP NOT NULL;
  