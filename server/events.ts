import type { Request, Response } from 'express';

const clients = new Set<Response>();

export function sseHandler(req: Request, res: Response): void {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write('retry: 2000\n\n');
  clients.add(res);
  const heartbeat = setInterval(() => res.write(': hb\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

export function broadcast(event: string, data: unknown = {}): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) client.write(payload);
}

export const hasClients = (): boolean => clients.size > 0;
