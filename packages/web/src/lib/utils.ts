import { clsx, type ClassValue } from 'clsx';
import { format, formatDistanceToNowStrict, isValid, parseISO } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { twMerge } from 'tailwind-merge';

/** Tailwind 类名合并：后写的同类工具类覆盖先写的，避免条件类名互相打架 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/* ------------------------------- 时间格式化 ------------------------------- */

export type DateInput = string | number | Date | null | undefined;

export function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : typeof value === 'number' ? new Date(value) : parseISO(value);
  return isValid(date) ? date : null;
}

/** 后端统一返回 RFC3339；解析失败时显示占位符而不是 Invalid Date */
export function formatDateTime(value: DateInput): string {
  const date = toDate(value);
  return date ? format(date, 'yyyy-MM-dd HH:mm', { locale: zhCN }) : '—';
}

export function formatDate(value: DateInput): string {
  const date = toDate(value);
  return date ? format(date, 'yyyy-MM-dd', { locale: zhCN }) : '—';
}

export function formatTime(value: DateInput): string {
  const date = toDate(value);
  return date ? format(date, 'HH:mm', { locale: zhCN }) : '—';
}

/** 「3 天前」这类相对时间；超过 30 天回退成绝对日期，避免「127 天前」这种无意义表述 */
export function formatRelative(value: DateInput): string {
  const date = toDate(value);
  if (!date) return '从未';
  const days = (Date.now() - date.getTime()) / 86_400_000;
  if (days > 30) return formatDate(date);
  return formatDistanceToNowStrict(date, { addSuffix: true, locale: zhCN });
}

/** 图表 X 轴的短标签 */
export function formatShortDate(value: DateInput): string {
  const date = toDate(value);
  return date ? format(date, 'MM-dd', { locale: zhCN }) : '';
}

/** 把 Date 转成后端查询参数要的 YYYY-MM-DD */
export function toDateParam(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

/* ------------------------------- 数值格式化 ------------------------------- */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

export function formatBytes(bytes: number | null | undefined, digits = 1): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—';
  if (bytes <= 0) return '0 B';

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const fixed = unit === 0 ? String(Math.round(value)) : value.toFixed(digits);
  return `${fixed} ${UNITS[unit]}`;
}

export interface DurationOptions {
  /** 紧凑写法（图表坐标轴、卡片角标用）：1.5 小时 → 「1.5h」，45 分钟 → 「45m」 */
  compact?: boolean;
}

/**
 * 阅读时长格式化。
 * 中文语境下「1 小时 23 分」比「01:23:00」更容易一眼读懂，因此默认走长格式。
 */
export function formatDuration(seconds: number | null | undefined, options: DurationOptions = {}): string {
  const total = Math.max(0, Math.floor(seconds ?? 0));

  if (options.compact) {
    if (total < 60) return `${total}s`;
    if (total < 3600) return `${Math.round(total / 60)}m`;
    if (total < 86400) return `${(total / 3600).toFixed(1)}h`;
    return `${(total / 86400).toFixed(1)}d`;
  }

  if (total < 60) return `${total} 秒`;
  if (total < 3600) return `${Math.floor(total / 60)} 分钟`;

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours < 24) return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;

  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} 天 ${restHours} 小时` : `${days} 天`;
}

/** 后端里 percentage 有时是 0-1 的小数（KOSync 语义），这里统一换算成 0-100 */
export function ratioToPercent(ratio: number | null | undefined, digits = 1): number {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return 0;
  const value = ratio <= 1 ? ratio * 100 : ratio;
  return Number(value.toFixed(digits));
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/* --------------------------------- 其它 --------------------------------- */

export const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

/** 标签输入：逗号/顿号/空格分隔都能识别，并去重 */
export function parseTags(input: string): string[] {
  return Array.from(
    new Set(
      input
        .split(/[,，、\s]+/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ).slice(0, 20);
}

/** 把任意文本复制到剪贴板；剪贴板 API 在非安全上下文不可用，回退到隐藏 textarea */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到下面的回退方案 */
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/** 文件扩展名（小写、不含点）；无扩展名返回空串 */
export function fileExtension(name: string): string {
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(index + 1).toLowerCase() : '';
}

/** 触发浏览器下载 */
export function triggerDownload(url: string, filename?: string): void {
  const link = document.createElement('a');
  link.href = url;
  if (filename) link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/* ------------------------------- MD5（秒传） ------------------------------- */

/**
 * 增量 MD5。
 *
 * 浏览器没有内置 MD5（WebCrypto 只提供 SHA 系列），而秒传接口要求 MD5。
 * 书库文件可能上百 MB，一次性读进内存再算会同时打爆内存和主线程，
 * 所以这里实现成可分块喂入的流式版本，配合 md5OfFile 的分片读取使用。
 *
 * 算法照搬 RFC 1321，K/S 表在类外只算一次。
 */
const MD5_SHIFTS = new Uint8Array([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5,
  9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21,
]);

const MD5_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(64);
  for (let i = 0; i < 64; i += 1) {
    table[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  }
  return table;
})();

export class Md5 {
  private a = 0x67452301;
  private b = 0xefcdab89;
  private c = 0x98badcfe;
  private d = 0x10325476;

  private readonly block = new Uint8Array(64);
  private blockLength = 0;
  private totalLength = 0;
  private finished = false;

  update(data: Uint8Array): this {
    if (this.finished) throw new Error('MD5 已结束，无法继续写入');
    this.totalLength += data.length;

    let offset = 0;

    // 先补满上一个未处理完的分块
    if (this.blockLength > 0) {
      const need = 64 - this.blockLength;
      const take = Math.min(need, data.length);
      this.block.set(data.subarray(0, take), this.blockLength);
      this.blockLength += take;
      offset = take;

      if (this.blockLength === 64) {
        this.hashBlock(this.block, 0);
        this.blockLength = 0;
      }
    }

    // 整块直接处理
    while (offset + 64 <= data.length) {
      this.hashBlock(data, offset);
      offset += 64;
    }

    // 余数留到下次
    if (offset < data.length) {
      this.block.set(data.subarray(offset), 0);
      this.blockLength = data.length - offset;
    }

    return this;
  }

  digest(): string {
    if (!this.finished) {
      const bitLength = this.totalLength * 8;

      // 补 0x80 与长度（小端 64 位）
      const padding = new Uint8Array(this.blockLength < 56 ? 64 - this.blockLength : 128 - this.blockLength);
      padding[0] = 0x80;
      const view = new DataView(padding.buffer);
      view.setUint32(padding.length - 8, bitLength >>> 0, true);
      view.setUint32(padding.length - 4, Math.floor(bitLength / 4294967296), true);

      this.update(padding);
      this.finished = true;
    }

    return [this.a, this.b, this.c, this.d].map(toLittleEndianHex).join('');
  }

  private hashBlock(source: Uint8Array, offset: number): void {
    const view = new DataView(source.buffer, source.byteOffset + offset, 64);
    const m = new Uint32Array(16);
    for (let i = 0; i < 16; i += 1) m[i] = view.getUint32(i * 4, true);

    let a = this.a;
    let b = this.b;
    let c = this.c;
    let d = this.d;

    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;

      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }

      const sum = (a + f + (MD5_TABLE[i] ?? 0) + (m[g] ?? 0)) | 0;
      const shift = (MD5_SHIFTS[i] ?? 0) % 32;
      const rotated = ((sum << shift) | (sum >>> (32 - shift))) | 0;

      a = d;
      d = c;
      c = b;
      b = (b + rotated) | 0;
    }

    this.a = (this.a + a) | 0;
    this.b = (this.b + b) | 0;
    this.c = (this.c + c) | 0;
    this.d = (this.d + d) | 0;
  }
}

function toLittleEndianHex(value: number): string {
  let out = '';
  for (let i = 0; i < 4; i += 1) {
    out += ((value >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
  }
  return out;
}

export function md5OfBuffer(buffer: ArrayBuffer): string {
  return new Md5().update(new Uint8Array(buffer)).digest();
}

/**
 * 分片计算文件 MD5。
 * 每片之间让出主线程（setTimeout 0），否则大文件哈希期间页面完全无法交互。
 */
export async function md5OfFile(file: File, onProgress?: (percent: number) => void): Promise<string> {
  const hasher = new Md5();
  const CHUNK_SIZE = 4 * 1024 * 1024;
  let offset = 0;

  while (offset < file.size) {
    const slice = file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size));
    const buffer = await slice.arrayBuffer();
    hasher.update(new Uint8Array(buffer));
    offset += buffer.byteLength;
    onProgress?.(Math.round((offset / Math.max(1, file.size)) * 100));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return hasher.digest();
}
