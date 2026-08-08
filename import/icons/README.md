# PWA Icons

This directory should contain the following icon files for the PWA:

## Required Icons

1. **icon-192.png** (192x192px)
   - Main app icon
   - Used for home screen, PWA manifest
   
2. **icon-512.png** (512x512px)
   - High-resolution icon
   - Used for splash screens, app stores

3. **apple-touch-icon.png** (180x180px)
   - iOS home screen icon
   - Add to HTML head as `<link rel="apple-touch-icon" href="/import/icons/apple-touch-icon.png">`

## Design Guidelines

- Use the Choice Properties brand color: #6366f1 (indigo)
- Include a simple house or "CP" monogram
- Ensure icons work on both light and dark backgrounds
- Use transparent background (PNG)

## Quick Generation

You can generate icons from a single source image:

```bash
# Using ImageMagick
convert logo.png -resize 192x192 icon-192.png
convert logo.png -resize 512x512 icon-512.png
convert logo.png -resize 180x180 apple-touch-icon.png

# Or use an online tool like https://favicon.io/
```

## Placeholder Icons

For testing, you can use placeholder icons from:
- https://via.placeholder.com/192x192/6366f1/ffffff?text=CP
- https://via.placeholder.com/512x512/6366f1/ffffff?text=CP

Download these and save to this directory as icon-192.png and icon-512.png