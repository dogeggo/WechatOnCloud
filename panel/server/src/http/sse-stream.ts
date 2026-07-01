import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ServerResponse } from 'node:http';

export interface SseClient<TMeta> {
  id: number;
  meta: TMeta;
  res: ServerResponse;
  heartbeat: NodeJS.Timeout;
  onClose?: (client: SseClient<TMeta>) => void;
}

export class SseClientHub<TMeta> {
  private clients = new Map<number, SseClient<TMeta>>();
  private clientSeq = 0;

  constructor(private readonly heartbeatMs = 25_000) {}

  open(
    req: FastifyRequest,
    reply: FastifyReply,
    meta: TMeta,
    options: { onClose?: (client: SseClient<TMeta>) => void } = {},
  ): SseClient<TMeta> {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const clientId = ++this.clientSeq;
    let client!: SseClient<TMeta>;
    const heartbeat = setInterval(() => {
      this.writeComment(client, `ping ${Date.now()}`);
    }, this.heartbeatMs);
    client = {
      id: clientId,
      meta,
      res,
      heartbeat,
      onClose: options.onClose,
    };
    this.clients.set(clientId, client);
    this.writeComment(client, 'connected');

    const close = () => this.close(client);
    req.raw.once('close', close);
    res.once('close', close);
    res.once('error', close);
    return client;
  }

  all(): IterableIterator<SseClient<TMeta>> {
    return this.clients.values();
  }

  send(client: SseClient<TMeta>, eventName: string, id: string, data: unknown): boolean {
    return this.write(client, sseMessage(eventName, id, data));
  }

  writeComment(client: SseClient<TMeta>, text: string): boolean {
    return this.write(client, `: ${text}\n\n`);
  }

  close(clientOrId: SseClient<TMeta> | number): void {
    const id = typeof clientOrId === 'number' ? clientOrId : clientOrId.id;
    const client = this.clients.get(id);
    if (!client) return;
    this.clients.delete(id);
    clearInterval(client.heartbeat);
    try {
      client.onClose?.(client);
    } catch {
      /* ignore SSE cleanup errors */
    }
    try {
      if (!client.res.destroyed) client.res.end();
    } catch {
      /* ignore closed SSE client */
    }
  }

  private write(client: SseClient<TMeta>, message: string): boolean {
    if (!this.clients.has(client.id) || client.res.destroyed) {
      this.close(client);
      return false;
    }
    try {
      client.res.write(message);
      return true;
    } catch {
      this.close(client);
      return false;
    }
  }
}

export function sseMessage(eventName: string, id: string, data: unknown): string {
  return [
    `id: ${id}`,
    `event: ${eventName}`,
    `data: ${JSON.stringify(data)}`,
    '',
    '',
  ].join('\n');
}
