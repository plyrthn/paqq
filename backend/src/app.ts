import { handleList } from './handlers/list';
import { handleGet } from './handlers/get';
import { handleAmazonImport } from './handlers/amazon-import';
import { sourcesRegistry } from './sources';
import type { TrackingScheduler } from './scheduler';
import {
  CARRIER_CREDENTIAL_SCHEMAS,
  resolveEnvWithSettings,
  type PaqqSettings,
} from './settings-schema';

export interface RequestServices {
  scheduler?: TrackingScheduler;
  settings?: {
    getSettings: () => Promise<PaqqSettings>;
    updateSettings: (patch: unknown) => Promise<PaqqSettings>;
  };
  notifications?: {
    sendTestNotification: () => Promise<{ ok: boolean; detail?: string }>;
  };
  health?: {
    getReport: () => Promise<unknown[]>;
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export async function handleRequest(
  request: Request,
  env: any,
  services: RequestServices = {}
): Promise<Response> {
  let runtimeEnv = env;
  if (services.settings) {
    try {
      const settings = await services.settings.getSettings();
      runtimeEnv = resolveEnvWithSettings(env, settings);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read settings';
      return jsonResponse({ error: message }, 500);
    }
  }

  sourcesRegistry.initialize(runtimeEnv);

  const url = new URL(request.url);

  if (url.pathname === '/api/list') {
    return handleList(request);
  }

  if (url.pathname === '/api/get') {
    return handleGet(request, runtimeEnv, services.scheduler);
  }

  if (url.pathname === '/api/amazon/import' && request.method === 'POST') {
    return handleAmazonImport(request, runtimeEnv);
  }

  if (url.pathname === '/api/settings/schema' && request.method === 'GET') {
    return jsonResponse({
      carriers: CARRIER_CREDENTIAL_SCHEMAS,
      notifications: {
        fields: [
          { key: 'enabled', label: 'Enable notifications', type: 'boolean' },
          { key: 'appriseUrls', label: 'Apprise URLs', type: 'string[]' },
          {
            key: 'notifyOnStatusChange',
            label: 'Notify on status changes',
            type: 'boolean',
          },
          {
            key: 'notifyOnDelivered',
            label: 'Notify on delivered updates',
            type: 'boolean',
          },
        ],
      },
    });
  }

  if (url.pathname === '/api/settings' && request.method === 'GET') {
    if (!services.settings) {
      return jsonResponse({ error: 'Settings are unavailable in this runtime' }, 404);
    }
    const settings = await services.settings.getSettings();
    return jsonResponse(settings);
  }

  if (url.pathname === '/api/settings' && request.method === 'PUT') {
    if (!services.settings) {
      return jsonResponse({ error: 'Settings are unavailable in this runtime' }, 404);
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    try {
      const updated = await services.settings.updateSettings(payload);
      return jsonResponse(updated);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update settings';
      return jsonResponse({ error: message }, 400);
    }
  }

  if (url.pathname === '/api/settings/notifications/test' && request.method === 'POST') {
    if (!services.notifications) {
      return jsonResponse({ error: 'Notifications are unavailable in this runtime' }, 404);
    }
    const result = await services.notifications.sendTestNotification();
    return jsonResponse(result, result.ok ? 200 : 500);
  }

  if (url.pathname === '/api/health/sources') {
    if (!services.health) {
      return jsonResponse({ error: 'Source health is unavailable in this runtime' }, 404);
    }
    const sources = await services.health.getReport();
    return jsonResponse({ sources });
  }

  if (url.pathname === '/api/scheduler/status') {
    if (!services.scheduler) {
      return jsonResponse({ error: 'Scheduler is unavailable in this runtime' }, 404);
    }
    return jsonResponse(services.scheduler.getStatus());
  }

  if (url.pathname === '/api/scheduler/targets') {
    if (!services.scheduler) {
      return jsonResponse({ error: 'Scheduler is unavailable in this runtime' }, 404);
    }
    const targets = await services.scheduler.listTargets();
    return jsonResponse(targets);
  }

  if (url.pathname === '/api/scheduler/watch' && request.method === 'POST') {
    if (!services.scheduler) {
      return jsonResponse({ error: 'Scheduler is unavailable in this runtime' }, 404);
    }

    let payload: any;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const source = typeof payload?.source === 'string' ? payload.source.trim() : '';
    const params = payload?.params;
    const friendlyName =
      typeof payload?.friendlyName === 'string' && payload.friendlyName.trim().length > 0
        ? payload.friendlyName.trim()
        : undefined;

    if (!source || !sourcesRegistry.has(source)) {
      return jsonResponse({ error: 'Source not found' }, 404);
    }

    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      return jsonResponse({ error: 'params must be an object' }, 400);
    }

    const normalizedParams: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        return jsonResponse({ error: `Invalid param value for '${key}'` }, 400);
      }
      normalizedParams[key] = value.trim();
    }

    const trackingSource = sourcesRegistry.get(source)!;
    for (const field of trackingSource.getConfig().requiredFields) {
      if (!normalizedParams[field]) {
        return jsonResponse({ error: `Missing required field: ${field}` }, 400);
      }
    }

    await services.scheduler.registerTarget(source, normalizedParams, { friendlyName });
    return jsonResponse({ ok: true });
  }

  if (url.pathname === '/api/scheduler/unwatch' && request.method === 'POST') {
    if (!services.scheduler) {
      return jsonResponse({ error: 'Scheduler is unavailable in this runtime' }, 404);
    }

    let payload: any;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const source = typeof payload?.source === 'string' ? payload.source.trim() : '';
    const params = payload?.params;

    if (!source || !sourcesRegistry.has(source)) {
      return jsonResponse({ error: 'Source not found' }, 404);
    }

    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      return jsonResponse({ error: 'params must be an object' }, 400);
    }

    const normalizedParams: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        return jsonResponse({ error: `Invalid param value for '${key}'` }, 400);
      }
      normalizedParams[key] = value.trim();
    }

    const removed = await services.scheduler.unregisterTarget(source, normalizedParams);
    return jsonResponse({ removed });
  }

  if (url.pathname === '/api/scheduler/run' && request.method === 'POST') {
    if (!services.scheduler) {
      return jsonResponse({ error: 'Scheduler is unavailable in this runtime' }, 404);
    }
    const started = await services.scheduler.runNow({ force: true });
    return jsonResponse({ started });
  }

  return new Response('Not found', { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } });
}
