#!/bin/bash
set -e

echo "🚀 Choice Properties - Auto Deploy Script"
echo "=========================================="
echo ""

# Operate from the current working directory (repo root), not a hardcoded path.
# Previously hardcoded /workspaces/choicepropertiesofficial (a stale Replit path).
cd "$(dirname "$0")"

echo "📊 Checking git status..."
git status

echo ""
echo "📝 Staging all files..."
git add -A

echo ""
echo "✅ Committing changes..."
git commit -m "Deploy critical photo upload fix: base64 to binary conversion

Core Fix:
- imagekit-upload/index.ts: Convert base64 string to binary Blob before ImageKit upload
- Added comprehensive debug logging at every step
- Improved error messages with debug context

This fixes all photo upload failures related to incorrect data format."

echo ""
echo "🔄 Checking git log..."
git log --oneline -5

echo ""
echo "📤 Pushing to GitHub (main)..."
git push origin main

if [ $? -eq 0 ]; then
  echo ""
  echo "✅ SUCCESS! All changes pushed to GitHub!"
  echo ""
  echo "📊 Auto-deployment starting:"
  echo "   ⏳ Supabase Edge Functions (1-2 min)"
  echo "   ⏳ Cloudflare Pages (1-2 min)"
  echo ""
  echo "🧪 After 5 minutes, try uploading a photo:"
  echo "   → Landlord Settings / Profile Picture"
  echo "   → Or Create Listing / Add Photos"
  echo ""
  echo "📞 Check deployment status:"
  echo "   → GitHub: https://github.com/choicepropertyofficial1-collab/choicepropertiesofficial/commits/main"
  echo "   → Supabase: Edge Functions → imagekit-upload → Logs"
  echo "   → Cloudflare: Pages → choicepropertiesofficial → Deployments"
else
  echo ""
  echo "❌ Push failed. Possible issues:"
  echo "   1. Network connection problem"
  echo "   2. GitHub authentication failed"
  echo "   3. Repository access issue"
  echo ""
  echo "Try again in a few moments, or check your GitHub connection."
fi
