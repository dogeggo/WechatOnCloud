import type { FastifyReply, FastifyRequest } from 'fastify';
import { MIB } from '../config/panel-config.js';
import { httpError } from './http-error.js';

export interface RawUpload {
  stream: NodeJS.ReadableStream;
  size: number;
}

function contentLength(req: FastifyRequest, maxBytes: number): number {
  const raw = req.headers['content-length'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^\d+$/.test(value)) {
    throw httpError(411, '上传请求必须包含 Content-Length');
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw httpError(400, '上传内容为空或大小不合法');
  }
  if (n > maxBytes) {
    throw httpError(413, `上传文件过大，上限 ${Math.round(maxBytes / MIB)} MiB`);
  }
  return n;
}

export function rawUpload(req: FastifyRequest, maxBytes: number): RawUpload {
  const size = contentLength(req, maxBytes);
  const body = req.body as any;
  if (!body || typeof body.pipe !== 'function') {
    throw httpError(415, '请使用 application/octet-stream 上传文件');
  }
  return { stream: body as NodeJS.ReadableStream, size };
}

export function gzipQuery(req: FastifyRequest): boolean {
  const gzip = String((req.query as any)?.gzip ?? '');
  if (gzip === '1') return true;
  if (gzip === '0') return false;
  throw httpError(400, '缺少 gzip 参数');
}

export function sendBinary(reply: FastifyReply, body: Buffer | NodeJS.ReadableStream, filename: string, contentType: string) {
  reply.header('content-type', contentType);
  reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  return reply.send(body);
}
