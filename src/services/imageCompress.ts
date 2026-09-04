/**
 * 识图前的图片压缩。
 *
 * 视觉模型对输入有硬限制（≤1MB、宽高各 ≤8000、最短边 ≥10），而手机拍出来的
 * 试卷照片动辄 4-8MB，直接传必定被拒。这里统一压到长边 2000px 的 JPEG，
 * 文字仍然清晰可辨，同时把体积压进 1MB。
 *
 * 只用 expo-image-manipulator：RN 环境没有 Canvas / Blob / FileReader。
 */
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

export interface ImageSource {
  uri: string;
  width?: number;
  height?: number;
  fileName?: string | null;
  mimeType?: string | null;
}

export interface CompressedImage {
  base64: string;
  mime: 'image/jpeg';
  width: number;
  height: number;
  bytes: number;
}

const MAX_BYTES = 1024 * 1024;
const MAX_EDGE = 2000;
const MIN_EDGE = 240;
const MAX_ATTEMPTS = 5;

function base64ByteLength(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/** 把任意本地图片压成 ≤1MB 的 JPEG，并直接返回 base64（省掉一次读文件） */
export async function compressImageForVision(asset: ImageSource): Promise<CompressedImage> {
  if (!asset.uri) throw new Error('图片地址为空');

  let width = Math.round(asset.width ?? 0);
  let height = Math.round(asset.height ?? 0);
  if (width > 0 && height > 0) {
    const longest = Math.max(width, height);
    if (longest > MAX_EDGE) {
      const scale = MAX_EDGE / longest;
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    const shortest = Math.min(width, height);
    if (shortest > 0 && shortest < MIN_EDGE) {
      const scale = MIN_EDGE / shortest;
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
  }

  let compress = 0.85;
  let last: CompressedImage | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const context = ImageManipulator.manipulate(asset.uri);
    if (width > 0 && height > 0) context.resize({ width, height });
    const rendered = await context.renderAsync();
    const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress, base64: true });
    const base64 = saved.base64 ?? '';
    if (!base64) throw new Error('图片压缩失败，请换一张图重试');

    last = {
      base64,
      mime: 'image/jpeg',
      width: saved.width,
      height: saved.height,
      bytes: base64ByteLength(base64),
    };
    console.log(
      `[imageCompress] 第 ${attempt + 1} 次压缩 ${saved.width}x${saved.height} quality=${compress.toFixed(2)} → ${(last.bytes / 1024).toFixed(0)}KB`,
    );
    if (last.bytes <= MAX_BYTES) return last;

    // 还是太大：先降分辨率再降质量，双管齐下
    if (width > 0 && height > 0) {
      width = Math.max(MIN_EDGE, Math.round(width * 0.8));
      height = Math.max(MIN_EDGE, Math.round(height * 0.8));
    }
    compress = Math.max(0.3, compress - 0.15);
  }

  throw new Error('图片压缩后仍超过 1MB，请裁掉多余部分再试');
}
