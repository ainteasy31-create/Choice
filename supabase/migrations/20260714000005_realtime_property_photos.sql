-- Enable Realtime broadcast for property_photos.
-- public.properties was already in the supabase_realtime publication;
-- property_photos was not, so admin UI subscriptions listening for photo
-- inserts/deletes (e.g. property-detail.js gallery, watermark-review.js
-- grid) would never receive events for that table without this.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'property_photos'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.property_photos;
  END IF;
END $$;
