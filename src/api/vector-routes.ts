import type { FastifyPluginAsync } from 'fastify';
import { publicationSlice } from '../services/publication.js';
import {
  REPORTED_VECTOR_DISCLAIMER,
  reportedVectorForEvent,
  reportedVectorsForLiveEvents,
  threatEventExists
} from '../services/threat-vectors.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Public threat vectors: the chain of reported observations for live threat events.
 *
 * This plugin imports exactly one module — `../services/threat-vectors.js` — and that module reaches
 * only the classification archive. There is no import path from here to
 * `../services/vector-projection.js`, and `src/api/vector-isolation.test.ts` walks the module graph
 * on every run to prove it. The operator-only extrapolation is registered by a different plugin,
 * `./ops-vector-routes.js`, which is the only file in the project allowed to name the `ops_` tables.
 *
 * Registered without `fastify-plugin`, matching `./occupation-routes.ts`: the encapsulation keeps
 * anything added here from reaching the rest of the server. Unlike the occupation layer these
 * payloads are *not* cached — the server-wide `Cache-Control: no-store` on JSON is inherited and is
 * correct here, because a chain changes the moment another source reports.
 */
const vectorRoutes: FastifyPluginAsync = async (app) => {
  /** Every live chain, in one request. This is what the map layer consumes. */
  app.get('/api/v1/vectors', async (request, reply) => {
    try {
      // Inside the try on purpose: a failed slice must degrade to "no chains" exactly as a failed
      // chain query does, never to a 500 the map has to special-case.
      const items = await reportedVectorsForLiveEvents((await publicationSlice()).cutoffAt);
      return { generatedAt: new Date().toISOString(), disclaimer: REPORTED_VECTOR_DISCLAIMER, items };
    } catch (error) {
      // The chain is an explanatory overlay on top of markers the map already draws. A failure here
      // must degrade to "no chains", never to a broken map, and never to a 500 the client has to
      // special-case.
      request.log.error({ error: String(error) }, 'reported vectors unavailable, serving empty list');
      return reply.send({ generatedAt: new Date().toISOString(), disclaimer: REPORTED_VECTOR_DISCLAIMER, items: [] });
    }
  });

  app.get<{ Params: { id: string } }>('/api/v1/threats/:id/vector', async (request, reply) => {
    if (!uuidPattern.test(request.params.id)) return reply.code(400).send({ error: 'invalid_id' });
    // Visibility is decided FIRST, before any chain is computed. An event created after the cutoff
    // must 404 exactly as `/api/v1/threats/:id` does, and computing its chain before deciding that
    // would be work done only to throw away — on the same pool the snapshot is competing for.
    const slice = await publicationSlice();
    if (!(await threatEventExists(request.params.id, slice.cutoffAt))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const vector = await reportedVectorForEvent(request.params.id);
    if (vector) return vector;
    // "This event has no chain" and "this event does not exist" are different answers, and the
    // client renders them differently: the first is an ordinary single-message threat.
    return reply.send({
      eventId: request.params.id,
      kind: 'reported_observation_chain',
      disclaimer: REPORTED_VECTOR_DISCLAIMER,
      nodes: [], segments: [],
      span: {
        from: null, to: null, elapsedSeconds: 0, sourceCount: 0,
        independenceGroupCount: 0, drawableSegments: 0, strongestBasis: null
      }
    });
  });
};

export default vectorRoutes;
export { vectorRoutes };
