import { Readable } from "node:stream";

const TAR_BLOCK_BYTES = 512;
const TAR_END_BYTES = TAR_BLOCK_BYTES * 2;
const TAR_NAME_BYTES = 100;

function tarNameByteLength(name: string): number {
  return Buffer.byteLength(name, "utf8");
}

export function tarNameFitsHeader(name: string): boolean {
  return tarNameByteLength(name) <= TAR_NAME_BYTES;
}

function assertTarName(name: string): void {
  if (!tarNameFitsHeader(name)) {
    throw new Error(
      `文件名过长，UTF-8 编码后不能超过 ${TAR_NAME_BYTES} 字节`,
    );
  }
}

function tarPadding(size: number): number {
  return (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
}

function writeField(
  header: Buffer,
  value: string,
  offset: number,
  length: number,
  encoding: BufferEncoding = "ascii",
): void {
  const bytes = Buffer.from(value, encoding);
  if (bytes.length > length) throw new Error("tar header 字段过长");
  bytes.copy(header, offset, 0, bytes.length);
}

function tarHeader(name: string, size: number): Buffer {
  if (!Number.isSafeInteger(size) || size < 0)
    throw new Error("文件大小不合法");
  assertTarName(name);

  const h = Buffer.alloc(TAR_BLOCK_BYTES, 0);
  writeField(h, name, 0, TAR_NAME_BYTES, "utf8"); // name
  writeField(h, "0000644\0", 100, 8); // mode
  writeField(h, "0001750\0", 108, 8); // uid 1000(octal 1750)
  writeField(h, "0001750\0", 116, 8); // gid 1000
  writeField(h, size.toString(8).padStart(11, "0") + "\0", 124, 12); // size
  writeField(h, "00000000000\0", 136, 12); // mtime
  writeField(h, "        ", 148, 8); // checksum 占位
  writeField(h, "0", 156, 1); // typeflag 普通文件
  writeField(h, "ustar\0", 257, 6);
  writeField(h, "00", 263, 2);

  let sum = 0;
  for (let i = 0; i < TAR_BLOCK_BYTES; i++) sum += h[i];
  writeField(h, sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

export function tarSingleFileStream(
  name: string,
  content: NodeJS.ReadableStream,
  size: number,
): Readable {
  const header = tarHeader(name, size);
  async function* gen() {
    yield header;
    let seen = 0;
    for await (const chunk of content as AsyncIterable<Buffer | string>) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      seen += b.length;
      if (seen > size) throw new Error("上传内容超过声明大小");
      yield b;
    }
    if (seen !== size) throw new Error("上传内容大小与 Content-Length 不一致");
    yield Buffer.alloc(tarPadding(size), 0);
    yield Buffer.alloc(TAR_END_BYTES, 0);
  }
  return Readable.from(gen());
}

class StreamByteReader {
  private readonly iterator: AsyncIterator<Buffer | string>;
  private readonly chunks: Buffer[] = [];
  private offset = 0;
  private buffered = 0;

  constructor(stream: NodeJS.ReadableStream) {
    this.iterator = (
      stream as AsyncIterable<Buffer | string>
    )[Symbol.asyncIterator]();
  }

  async readExact(size: number): Promise<Buffer> {
    await this.fill(size);
    if (this.buffered < size) throw new Error("Docker archive 数据不完整");
    return this.consume(size);
  }

  async skip(size: number): Promise<void> {
    let remaining = size;
    while (remaining > 0) {
      const chunk = await this.readSome(remaining);
      if (!chunk) throw new Error("Docker archive 数据不完整");
      remaining -= chunk.length;
    }
  }

  private async fill(minBytes: number): Promise<void> {
    while (this.buffered < minBytes) {
      const next = await this.iterator.next();
      if (next.done) return;
      const chunk = Buffer.isBuffer(next.value)
        ? next.value
        : Buffer.from(next.value);
      if (chunk.length === 0) continue;
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }
  }

  async readSome(maxBytes: number): Promise<Buffer | null> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("读取大小不合法");
    }
    await this.fill(1);
    if (this.buffered === 0) return null;
    const first = this.chunks[0];
    const available = first.length - this.offset;
    return this.consume(Math.min(maxBytes, available));
  }

  private consume(size: number): Buffer {
    const output = Buffer.allocUnsafe(size);
    let copied = 0;
    while (copied < size) {
      const first = this.chunks[0];
      const available = first.length - this.offset;
      const take = Math.min(size - copied, available);
      first.copy(output, copied, this.offset, this.offset + take);
      this.offset += take;
      this.buffered -= take;
      copied += take;
      if (this.offset === first.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    return output;
  }
}

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < block.length; i++) {
    if (block[i] !== 0) return false;
  }
  return true;
}

function parseTarSize(header: Buffer): number {
  const raw = header.subarray(124, 136);
  if ((raw[0] & 0x80) !== 0) {
    if ((raw[0] & 0x40) !== 0) throw new Error("tar 文件大小字段不合法");
    let size = BigInt(raw[0] & 0x7f);
    for (let i = 1; i < raw.length; i++) {
      size = (size << 8n) + BigInt(raw[i]);
    }
    if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("tar 文件大小超过服务端可处理范围");
    }
    return Number(size);
  }

  const text = raw
    .toString("ascii")
    .replace(/\0.*$/, "")
    .trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error("tar 文件大小字段不合法");
  const size = parseInt(text, 8);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("tar 文件大小字段不合法");
  }
  return size;
}

function isRegularFile(header: Buffer): boolean {
  return header[156] === 0 || header[156] === 0x30;
}

function destroyReadable(stream: NodeJS.ReadableStream, error?: Error): void {
  (stream as { destroy?: (err?: Error) => void }).destroy?.(error);
}

export async function singleFileFromTarStream(
  archive: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<Readable> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("下载大小上限不合法");
  }

  const reader = new StreamByteReader(archive);

  try {
    while (true) {
      const header = await reader.readExact(TAR_BLOCK_BYTES);
      if (isZeroBlock(header)) throw new Error("tar 归档中没有普通文件");

      const size = parseTarSize(header);
      const padding = tarPadding(size);
      if (!isRegularFile(header)) {
        await reader.skip(size + padding);
        continue;
      }

      if (size > maxBytes) {
        throw new Error(
          `下载文件过大，上限 ${Math.round(maxBytes / 1024 / 1024)} MiB`,
        );
      }

      async function* gen() {
        let remaining = size;
        try {
          while (remaining > 0) {
            const chunk = await reader.readSome(remaining);
            if (!chunk) throw new Error("Docker archive 数据不完整");
            remaining -= chunk.length;
            yield chunk;
          }
          if (padding > 0) await reader.skip(padding);
        } finally {
          destroyReadable(archive);
        }
      }

      return Readable.from(gen());
    }
  } catch (error) {
    destroyReadable(archive);
    throw error;
  }
}
