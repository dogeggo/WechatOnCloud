import type { FastifyReply } from 'fastify';

export class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

export function httpError(statusCode: number, message: string): HttpError {
  return new HttpError(statusCode, message);
}

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return fallback;
}

export function sendError(
  reply: FastifyReply,
  error: unknown,
  fallbackStatusCode: number,
  fallbackMessage: string,
) {
  const statusCode = error instanceof HttpError ? error.statusCode : fallbackStatusCode;
  return reply.code(statusCode).send({ error: errorMessage(error, fallbackMessage) });
}
