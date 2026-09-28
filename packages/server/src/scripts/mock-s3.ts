import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * 一个够用的假 S3，只为端到端验证「预签名直传」。
 *
 * 为什么必须用真的 HTTP 服务而不是打桩：预签名直传的关键在于**浏览器拿着
 * 签发的 URL 直接 PUT 到对象存储**。URL 由 AWS SDK 签出来、指向 endpoint，
 * 客户端据此发真实请求，服务端再用 HeadObject 回查 —— 这条链路里任何一环
 * （签名、寻址风格、key 前缀、ETag 语义）出问题都只有真跑一遍才看得出来。
 *
 * 只实现直传流程会用到的那几个动作：
 *   PUT    /{bucket}/{key}  写入并记录
 *   HEAD   /{bucket}/{key}  返回 Content-Length 与 ETag
 *   GET    /{bucket}/{key}  读取（用于验证内容确实一致）
 *   DELETE /{bucket}/{key}  删除
 *
 * 签名一概不验：本脚本要验的是 ReadSync 的逻辑，不是 AWS 的签名算法。
 *
 * 但**校验和的冲突要验**：真实 S3 / R2 在请求同时带两个非默认校验和时会直接
 * 拒绝（"You can only specify one non-default checksum at a time"），而 AWS SDK
 * v3.729+ 的默认完整性保护会主动加一个 crc32。若测试用的假 S3 对此照单全收，
 * 这个组合就能一路通过测试、到用户那里才炸。所以这里复刻真实的拒绝行为。
 */

interface StoredObject {
  body: Buffer;
  contentType: string;
}

export interface MockS3 {
  endpoint: string;
  bucket: string;
  /** 桶里当前的键值，供断言直接检查 */
  objects: Map<string, StoredObject>;
  /**
   * 收到的请求记录。带 headers 是为了排查「校验和冲突」这类问题 ——
   * 服务端拒的是请求头组合，只看方法+路径根本看不出发生了什么。
   */
  requests: { method: string; path: string; headers: Record<string, string | string[] | undefined> }[];
  close: () => Promise<void>;
  /**
   * 开关「让 HEAD 返回与内容不符的 ETag」，用于验证服务端的内容校验确实生效。
   * 用完必须关掉，否则后续针对同一个 key 的正常校验会一直被误伤。
   */
  corruptEtagFor: (key: string, corrupt?: boolean) => void;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 从 /{bucket}/{key...} 里剥出 bucket 与 key */
function parsePath(pathname: string, bucket: string): { bucket: string; key: string } | null {
  const clean = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (!clean.startsWith(`${bucket}/`)) return null;
  return { bucket, key: clean.slice(bucket.length + 1) };
}

export async function startMockS3(): Promise<MockS3> {
  const bucket = 'test-bucket';
  const objects = new Map<string, StoredObject>();
  const requests: { method: string; path: string; headers: Record<string, string | string[] | undefined> }[] = [];
  const corrupted = new Set<string>();

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      requests.push({ method: req.method ?? 'GET', path: url.pathname, headers: req.headers });

      const parsed = parsePath(url.pathname, bucket);
      if (!parsed) {
        res.writeHead(404).end();
        return;
      }
      const { key } = parsed;

      if (req.method === 'PUT') {
        /*
         * 复刻真实服务的约束：Content-MD5 与 x-amz-checksum-* 同属「非默认校验和」，
         * 一次请求里最多只能有一个，否则 400。
         */
        const nonDefault = [
          req.headers['content-md5'],
          req.headers['x-amz-checksum-crc32'],
          req.headers['x-amz-checksum-crc32c'],
          req.headers['x-amz-checksum-sha1'],
          req.headers['x-amz-checksum-sha256'],
          req.headers['x-amz-checksum-crc64nvme'],
        ].filter(Boolean);

        if (nonDefault.length > 1) {
          const message = 'You can only specify one non-default checksum at a time.';
          res
            .writeHead(400, { 'Content-Type': 'application/xml' })
            .end(
              `<?xml version="1.0" encoding="UTF-8"?><Error><Code>InvalidRequest</Code>` +
                `<Message>${message}</Message></Error>`,
            );
          return;
        }

        const body = await readBody(req);
        objects.set(key, {
          body,
          contentType: String(req.headers['content-type'] ?? 'application/octet-stream'),
        });
        // 单次 PUT 的 ETag 就是内容的 MD5 —— 与真实 S3/R2 的语义一致，
        // 服务端正是靠这一点在不下载文件的前提下校验内容
        const etag = createHash('md5').update(body).digest('hex');
        res.writeHead(200, { ETag: `"${etag}"` }).end();
        return;
      }

      if (req.method === 'HEAD') {
        const obj = objects.get(key);
        if (!obj) {
          res.writeHead(404).end();
          return;
        }
        const etag = corrupted.has(key)
          ? createHash('md5').update(`corrupted-${randomUUID()}`).digest('hex')
          : createHash('md5').update(obj.body).digest('hex');
        res
          .writeHead(200, {
            'Content-Length': String(obj.body.length),
            'Content-Type': obj.contentType,
            ETag: `"${etag}"`,
          })
          .end();
        return;
      }

      if (req.method === 'GET') {
        const obj = objects.get(key);
        if (!obj) {
          res.writeHead(404).end();
          return;
        }
        res
          .writeHead(200, {
            'Content-Length': String(obj.body.length),
            'Content-Type': obj.contentType,
          })
          .end(obj.body);
        return;
      }

      if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204).end();
        return;
      }

      res.writeHead(405).end();
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    endpoint: `http://127.0.0.1:${port}`,
    bucket,
    objects,
    requests,
    corruptEtagFor: (key: string, corrupt = true) => {
      if (corrupt) corrupted.add(key);
      else corrupted.delete(key);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
