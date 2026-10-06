import { api } from './api';

/**
 * 封面上传。
 *
 * 服务端把图片以 base64 存进数据库（book_covers 表），所以前端这边只需要
 * 在提交前把好两道关：格式与大小 —— 传到一半再被服务端拒绝，用户看到的
 * 是「失败」而不知道为什么。
 */

/** 与服务端 COVER_MIME_EXT 保持一致的允许格式 */
const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** `<input type="file">` 的 accept 属性 */
export const COVER_ACCEPT = ALLOWED_MIME.join(',');

/** 与服务端 COVER_MAX_BYTES 一致 */
const COVER_MAX_BYTES = 1.5 * 1024 * 1024;

/** 校验选中的文件；通过返回 null，否则返回能直接显示给用户的原因 */
export function validateCoverFile(file: File): string | null {
  if (!ALLOWED_MIME.includes(file.type)) {
    return '封面只支持 PNG / JPEG / WebP / GIF 图片';
  }
  if (file.size === 0) return '这个文件是空的';
  if (file.size > COVER_MAX_BYTES) {
    return `封面不能超过 1.5MB（当前 ${(file.size / 1024 / 1024).toFixed(1)}MB）`;
  }
  return null;
}

/**
 * 上传（或替换）某本书的封面。
 *
 * 走主站接口而不是「上传专用地址」：封面只有几百 KB，没必要绕道，而且那个
 * 地址可能是 http 的灰云域名，在 https 页面里会被浏览器当混合内容拦掉。
 */
export async function uploadBookCover(bookId: number, file: File): Promise<void> {
  const form = new FormData();
  form.append('file', file);
  await api.post(`/books/${bookId}/cover`, undefined, { formData: form });
}

/** 移除上传的封面（用户填的外链 coverUrl 不受影响） */
export async function removeBookCover(bookId: number): Promise<void> {
  await api.del(`/books/${bookId}/cover`);
}
