// Downscale a captured photo before sending it to the vision endpoint (Pattern #2). A raw phone photo is
// several MB of base64; we don't need that to read a fridge/receipt, and it bloats the request. Canvas APIs
// work in an insecure context (plain-http LAN), unlike getUserMedia — so the file-input → canvas → base64
// path is the LAN-safe one. DOM-only (no node), so it lives apart from the pure diff util.

const readAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(new Error('Could not read that image.'));
    r.readAsDataURL(file);
  });

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That image could not be loaded.'));
    img.src = src;
  });

export interface ScanPayload { imageBase64: string; mimeType: string }

// File → downscaled JPEG base64 (longest edge ≤ maxDim). Returns the bare base64 (no data: prefix) + mime.
export async function fileToScanPayload(file: File, maxDim = 1024, quality = 0.7): Promise<ScanPayload> {
  const img = await loadImage(await readAsDataUrl(file));
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
  const w = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
  const h = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not process that image.');
  ctx.drawImage(img, 0, 0, w, h);
  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  return { imageBase64: dataUrl.split(',')[1] || '', mimeType: 'image/jpeg' };
}
