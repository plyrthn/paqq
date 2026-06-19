import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { handleRequest } from './app';
import { TrackingScheduler } from './scheduler';
import { RuntimeSettingsStore } from './settings-store';
import { AppriseNotifier } from './apprise-notifier';
import { SourceHealthMonitor } from './source-health';

const port = Number(process.env.PORT ?? '8787');
const host = process.env.HOST ?? '0.0.0.0';
const settingsStore = new RuntimeSettingsStore(process.env);
const notifier = new AppriseNotifier(process.env, settingsStore);
const scheduler = new TrackingScheduler(process.env, {
  settings: settingsStore,
  notifications: notifier,
});
const healthMonitor = new SourceHealthMonitor(process.env, {
  scheduler,
  settings: settingsStore,
  notifications: notifier,
});
scheduler.setAfterRunHook(() => healthMonitor.evaluate());

void scheduler.start();

const server = createServer(async (req, res) => {
  try {
    if (req.url === '/health') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
      return;
    }

    const protocol = (req.headers['x-forwarded-proto'] as string) || 'http';
    const hostHeader = req.headers.host ?? `localhost:${port}`;
    const requestUrl = `${protocol}://${hostHeader}${req.url ?? '/'}`;

    const method = req.method ?? 'GET';
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'undefined') {
        continue;
      }
      if (Array.isArray(value)) {
        headers.set(key, value.join(', '));
      } else {
        headers.set(key, value);
      }
    }

    const init: RequestInit & { duplex?: 'half' } = {
      method,
      headers,
    };

    if (method !== 'GET' && method !== 'HEAD') {
      init.body = req as any;
      init.duplex = 'half';
    }

    const request = new Request(requestUrl, init);
    const response = await handleRequest(request, process.env, {
      scheduler,
      settings: settingsStore,
      notifications: notifier,
      health: healthMonitor,
    });

    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    if (!response.body) {
      res.end();
      return;
    }

    Readable.fromWeb(response.body as any).pipe(res);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Node runtime error';
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.setHeader('access-control-allow-origin', '*');
    res.end(JSON.stringify({ error: message }));
  }
});

server.listen(port, host, () => {
  process.stdout.write(`Paqq backend (node adapter) listening on ${host}:${port}\n`);
});

process.on('SIGTERM', () => scheduler.stop());
process.on('SIGINT', () => scheduler.stop());
