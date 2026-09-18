import { ApiError, api, getBlob } from './api';
import { triggerDownload } from './utils';

/**
 * 统一的书籍下载入口。
 *
 * README 要求 7：书库文件通常放在 WebDAV / 对象存储，本地只做中转。
 * 因此 /api/books/:id/download 有两种可能：
 *  1. 返回 { url }（S3 预签名直链）—— 直接跳转，不占用服务器带宽；
 *  2. 直接返回文件字节流 —— 需要带 Bearer 头取回再在前端触发保存。
 * 这里先按 JSON 探测一次，失败或不含 url 就退化成二进制下载。
 */
interface DownloadDescriptor {
  url?: string;
  downloadUrl?: string;
  mode?: string;
}

export async function downloadBookFile(bookId: number, filename: string): Promise<void> {
  let descriptor: DownloadDescriptor | null = null;

  try {
    descriptor = await api.get<DownloadDescriptor | null>(`/books/${bookId}/download`);
  } catch (err) {
    // 404 之外的错误（例如后端就绪但存储不可用）直接抛给调用方提示
    if (err instanceof ApiError && !err.isMissing) throw err;
    // 也允许端点直接返回字节流，此时 JSON 解析失败会落到这里
  }

  const directUrl = descriptor?.url ?? descriptor?.downloadUrl;
  if (directUrl) {
    triggerDownload(directUrl, filename);
    return;
  }

  const blob = await getBlob(`/books/${bookId}/download`);
  const objectUrl = URL.createObjectURL(blob);
  triggerDownload(objectUrl, filename);
  // 交给浏览器完成下载后再释放，立即 revoke 会让部分浏览器拿到空文件
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}
