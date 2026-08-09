# Orion Network Error Fix - Deployment Instructions

## What Was Fixed
The "network error" was caused by Orion iOS blocking CORS preflight requests triggered by the custom `x-import-secret` header. The fix sends the secret as a query parameter instead, avoiding the preflight.

## Step 1: Deploy the Edge Function

You need to deploy the updated Edge Function to Supabase:

```bash
# Navigate to the project directory
cd c:/Users/HP/Choice

# Deploy using Supabase CLI
supabase functions deploy receive-pipeline-import --project-ref tlfmwetmhthpyrytrcfo
```

**Alternative: Deploy via Supabase Dashboard**
1. Go to https://supabase.com/dashboard/project/tlfmwetmhthpyrytrcfo/functions
2. Click on `receive-pipeline-import`
3. Click "Deploy" or update the code directly in the editor
4. Copy the code from `supabase/functions/receive-pipeline-import/index.ts`

## Step 2: Reload the Extension in Orion

1. Open Orion on your iPhone
2. Go to **Settings → Extensions**
3. Find "Import to Choice Properties"
4. Tap **Reload** (or remove and re-add if reload isn't available)

## Step 3: Test the Fix

1. In Orion, navigate to any Zillow listing page (e.g., `https://www.zillow.com/homedetails/...`)
2. Wait for the "Save to Pipeline" button to appear
3. Tap the button
4. It should now show "Saving..." and then "Saved! X photos · Q:XX"

## Step 4: Verify Success

- Check your pipeline at: https://choice-properties-site.pages.dev/admin/pipeline
- The listing should appear there with all photos and data

## Troubleshooting

If it still shows "Network error":

1. **Check Orion console for errors:**
   - In Orion, enable Developer Mode
   - Open browser console and look for `[CP]` prefixed logs
   - Share any error messages you see

2. **Verify Edge Function is deployed:**
   - Visit: https://tlfmwetmhthpyrytrcfo.supabase.co/functions/v1/receive-pipeline-import?secret=cp_import_7Kx3m9P2w5
   - Should return an error about missing POST data (that's expected - it means the function is live)

3. **Check CORS headers:**
   - The server should return `Access-Control-Allow-Origin: chrome-extension://...`
   - This is already configured in `supabase/functions/_shared/cors.ts`

## Files Changed

- `chrome-extension/content.js` - Upload logic now sends secret as query param
- `supabase/functions/receive-pipeline-import/index.ts` - Accepts secret from query param or header

## Rollback (if needed)

If issues persist, you can temporarily revert to the old version by checking out the previous commit:
```bash
git checkout HEAD~1 -- chrome-extension/content.js supabase/functions/receive-pipeline-import/index.ts