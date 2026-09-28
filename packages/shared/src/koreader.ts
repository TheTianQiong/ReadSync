/**
 * KOReader 的文档标识算法。
 *
 * 阅读器同步进度时用它标识「是哪本书」。它**不是整文件 MD5**，而是一个
 * 采样 MD5：在 12 个按 4 的幂递增的固定偏移各读 1KB，拼起来算 MD5
 * （最多 12KB）。这样几 MB 的书也能瞬间算出标识，且与文件路径无关 ——
 * 同一本书拷到另一台设备、换个文件名，标识依然相同。
 *
 * 实现见 KOReader 的 `frontend/util.lua` 的 `util.partialMD5`：
 *
 *     local step, size = 1024, 1024
 *     local update = md5()
 *     for i = -1, 10 do
 *         file:seek("set", lshift(step, 2*i))
 *         local sample = file:read(size)
 *         if sample then update(sample) else break end
 *     end
 *
 * 之所以把这个算法放到 shared：服务端要在上传时算它（用来把进度关联到书），
 * 浏览器也要在预签名直传时算它（文件不经过服务端，只能在前端算）。
 * 两边各写一份的话，偏移量这种一改就错、错了还不报错的细节迟早会走样。
 */

/** 每次采样的字节数 */
export const KOREADER_SAMPLE_SIZE = 1024;

/**
 * 采样偏移序列（字节）：**0**、1K、4K、16K …… 1G。
 *
 * 对应 `lshift(1024, 2*i)`，i 取 -1..10，**按 32 位移位语义求值**。
 *
 * 第一个值看着别扭，但必须照抄：i = -1 时移位量 2*i = -2 被掩码成 30，
 * `1024 << 30` 在 32 位下溢出为 0 —— 所以第一片是从**文件开头**采的。
 * 这不是记错的公式，而是 KOReader 一直以来的实际行为；
 * 「修正」成 256 反而与所有既有实现都对不上（KOSync 上表现为：
 * 明明同一本书，服务端认不出来）。
 *
 * 写成算好的常量而不是循环，就是为了让这份取值一眼可核对 ——
 * 它是跨实现必须逐字节一致的地方。JS 的 `<<` 同样按 32 位掩码，
 * 所以 `1024 << -2` 在 JS 里也等于 0。
 */
export const KOREADER_SAMPLE_OFFSETS: readonly number[] = [
  0, //              lshift(1024, -2) → 移位数掩码为 30，32 位下溢出为 0
  1024, //           lshift(1024, 0)
  4096, //           lshift(1024, 2)
  16384, //          lshift(1024, 4)
  65536, //          lshift(1024, 6)
  262144, //         lshift(1024, 8)
  1048576, //        lshift(1024, 10)  1 MiB
  4194304, //        lshift(1024, 12)  4 MiB
  16777216, //       lshift(1024, 14)  16 MiB
  67108864, //       lshift(1024, 16)  64 MiB
  268435456, //      lshift(1024, 18)  256 MiB
  1073741824, //     lshift(1024, 20)  1 GiB
];

/** MD5 计算器的最小接口；服务端用 node:crypto，浏览器用自带的实现 */
export interface Md5Like {
  update(data: Uint8Array): void;
  digest(): string;
}

/**
 * 按 KOReader 的规则读取采样并算出文档标识。
 *
 * `read(offset, length)` 返回该位置的字节；读不到（已到文件末尾）返回 null。
 * 任何一次读返回 null 就停下 —— 与 KOReader 里 `if sample then ... else break`
 * 的行为一致。注意「读到的字节少于 length」不算结束，那一片仍要计入。
 *
 * 调用方负责提供 MD5 实现与读取方式：服务端读本地文件，浏览器读 File 切片。
 */
export async function computeKoreaderDocumentId(
  createHasher: () => Md5Like,
  read: (offset: number, length: number) => Promise<Uint8Array | null>,
): Promise<string> {
  const hasher = createHasher();

  for (const offset of KOREADER_SAMPLE_OFFSETS) {
    const sample = await read(offset, KOREADER_SAMPLE_SIZE);
    if (sample === null || sample.length === 0) break;
    hasher.update(sample);
  }

  return hasher.digest();
}
