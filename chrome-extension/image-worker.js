self.onmessage = async function(e) {
  const { id, buffer, maxWidth, quality } = e.data;
  try {
    const blob = new Blob([buffer]);
    // createImageBitmap works in workers
    const img = await createImageBitmap(blob);
    const ratio = Math.min(1, (maxWidth || 1600) / img.width);
    const w = Math.round(img.width * ratio);
    const h = Math.round(img.height * ratio);
    // Use OffscreenCanvas to draw
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    // Convert to blob (webp) if supported
    let outBlob;
    try {
      outBlob = await canvas.convertToBlob({ type: 'image/webp', quality: (quality || 0.85) });
    } catch (err) {
      // fallback to jpeg
      outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: (quality || 0.85) });
    }
    const arrayBuffer = await outBlob.arrayBuffer();
    postMessage({ id, ok: true, buffer: arrayBuffer, type: outBlob.type }, [arrayBuffer]);
  } catch (err) {
    postMessage({ id, ok: false, error: String(err || 'error') });
  }
};
