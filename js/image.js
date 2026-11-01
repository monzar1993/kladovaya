// Декодирует файл изображения с учётом EXIF-поворота.
export async function decodeImage(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // старые Safari: createImageBitmap не умеет Blob
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Уменьшает фото и пережимает в JPEG, чтобы оно занимало десятки килобайт, а не мегабайты.
export async function compressImage(file, maxSize = 1080, quality = 0.82) {
  const source = await decodeImage(file);
  const scale = Math.min(1, maxSize / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close?.();
  return canvas.toDataURL('image/jpeg', quality);
}
