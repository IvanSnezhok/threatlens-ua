import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Registry } from 'prom-client';
import {
  emptyOccupationPayloadView,
  occupationPayloadView,
  registerOccupationMetrics,
  type OccupationPayloadView
} from '../services/occupation.js';

export interface OccupationRoutesOptions {
  /** Pass the server registry so occupation metrics show up on /metrics. */
  metricsRegistry?: Registry;
}

const CACHEABLE = 'public, max-age=120, stale-while-revalidate=3600';
const CACHE_CONTROL = Symbol('occupationCacheControl');

function setCacheControl(reply: FastifyReply, value: string): void {
  (reply as unknown as Record<symbol, string>)[CACHE_CONTROL] = value;
}

function etagMatches(header: string, etag: string): boolean {
  if (header.trim() === '*') return true;
  const normalize = (value: string) => value.trim().replace(/^W\//, '');
  const wanted = normalize(etag);
  return header.split(',').some((candidate) => normalize(candidate) === wanted);
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function notModified(request: FastifyRequest, view: OccupationPayloadView): boolean {
  const ifNoneMatch = first(request.headers['if-none-match']);
  if (ifNoneMatch) return etagMatches(ifNoneMatch, view.etag);
  const ifModifiedSince = first(request.headers['if-modified-since']);
  if (!ifModifiedSince) return false;
  const since = Date.parse(ifModifiedSince);
  const lastModified = Date.parse(view.lastModified);
  return Number.isFinite(since) && Number.isFinite(lastModified) && lastModified <= since;
}

/**
 * Temporarily occupied territories layer.
 *
 * Registered without fastify-plugin on purpose: the encapsulation keeps the cache headers below
 * scoped to this route. The server-wide onSend hook forces `Cache-Control: no-store` on every JSON
 * response, and child hooks run after inherited ones — that is what lets this payload, which is
 * hundreds of kilobytes and changes about once a day, actually be cached.
 */
const occupationRoutes: FastifyPluginAsync<OccupationRoutesOptions> = async (app, options) => {
  if (options.metricsRegistry) registerOccupationMetrics(options.metricsRegistry);

  app.addHook('onSend', async (_request, reply, payload) => {
    const value = (reply as unknown as Record<symbol, string | undefined>)[CACHE_CONTROL];
    if (value) reply.header('Cache-Control', value);
    return payload;
  });

  app.get('/api/v1/occupation', async (request, reply) => {
    // Never 5xx: the map has to stay usable without this layer, so a failure degrades to the same
    // empty-and-stale shape the client already handles for "no revision stored yet".
    let view: OccupationPayloadView;
    let cacheable = true;
    try {
      view = await occupationPayloadView();
    } catch (error) {
      request.log.error({ error: String(error) }, 'occupation payload unavailable, serving empty layer');
      view = emptyOccupationPayloadView();
      cacheable = false;
    }

    setCacheControl(reply, cacheable ? CACHEABLE : 'no-store');
    reply.header('ETag', view.etag);
    reply.header('Last-Modified', view.lastModified);
    reply.header('Vary', 'Accept-Encoding');
    if (cacheable && notModified(request, view)) return reply.code(304).send();
    return reply.type('application/json; charset=utf-8').send(view.json);
  });
};

export default occupationRoutes;
export { occupationRoutes };
