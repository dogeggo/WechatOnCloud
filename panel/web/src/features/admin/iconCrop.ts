export type CropArea = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export async function cropToDataUrl(src: string, area: CropArea): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const next = new Image();
    next.onload = () => resolve(next);
    next.onerror = reject;
    next.src = src;
  });
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器不支持图片裁剪');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, area.x, area.y, area.width, area.height, 0, 0, size, size);
  return canvas.toDataURL('image/png');
}
