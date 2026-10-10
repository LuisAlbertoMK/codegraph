/**
 * Engram Stub Server
 *
 * Mock HTTP API mirroring the real Engram endpoints (v3.x) for development.
 * Runs on port 4199 by default (ENGRAM_STUB_PORT env var).
 *
 * Mirrored real behavior:
 *   POST /sessions            — ensure a session ({id, project} required, idempotent)
 *   POST /observations        — save (session_id + content required; same
 *                               deduplication_key upserts: same id, revision grows)
 *   GET  /observations/:id    — fetch one (revision_count/duplicate_count included)
 *   GET  /search              — BARE ARRAY of observations (rank doubles as score)
 *   GET  /health              — health check
 *   DELETE /observations/:id — delete an observation
 *
 * Usage:
 *   node scripts/engram-stub.mjs
 *   ENGRAM_STUB_PORT=5000 node scripts/engram-stub.mjs
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = parseInt(process.env.ENGRAM_STUB_PORT || '4199', 10);

// In-memory stores (mirror Engram's SQLite persistence conceptually)
const sessions = new Map();
const observations = new Map();
let nextId = 1;

const server = createServer((req, res) => {
  // CORS headers for MCP/HTTP clients
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // Health check
  if (path === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', observations: observations.size }));
    return;
  }

  // POST /sessions — ensure a session (idempotent)
  if (path === '/sessions' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!data.id || !data.project) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'id and project are required' }));
          return;
        }
        if (!sessions.has(data.id)) {
          sessions.set(data.id, { id: data.id, project: data.project });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: data.id, status: 'created' }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // POST /observations — save insight (upsert on deduplication_key)
  if (path === '/observations' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!data.session_id || !data.content) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'session_id and content are required' }));
          return;
        }
        if (!sessions.has(data.session_id)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'session not found' }));
          return;
        }

        // Deduplication: same key upserts the same id (revision grows)
        let existing = null;
        if (data.deduplication_key) {
          for (const obs of observations.values()) {
            if (obs.deduplication_key === data.deduplication_key) {
              existing = obs;
              break;
            }
          }
        }

        const now = new Date().toISOString();
        const observation = {
          id: existing ? existing.id : nextId++,
          session_id: data.session_id,
          title: data.title || 'Untitled',
          content: data.content,
          type: data.type || 'discovery',
          scope: data.scope || 'project',
          topic_key: data.topic_key || null,
          project: data.project || null,
          deduplication_key: data.deduplication_key || null,
          metadata: data.metadata || {},
          revision_count: existing ? existing.revision_count + 1 : 1,
          duplicate_count: existing ? existing.duplicate_count + 1 : 0,
          created_at: existing ? existing.created_at : now,
          updated_at: now,
        };

        observations.set(observation.id, observation);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: observation.id, status: 'saved' }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // GET /observations/:id — fetch one
  const getMatch = path.match(/^\/observations\/(.+)$/);
  if (getMatch && req.method === 'GET') {
    const id = Number(getMatch[1]);
    const obs = observations.get(id) ?? observations.get(getMatch[1]);
    if (obs) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obs));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    }
    return;
  }

  // GET /search — BARE ARRAY (rank doubles as score, like the real API)
  if (path === '/search' && req.method === 'GET') {
    const query = (url.searchParams.get('q') || '').toLowerCase();
    const limit = parseInt(url.searchParams.get('limit') || '5', 10);
    const project = url.searchParams.get('project') || null;

    let results = Array.from(observations.values());

    // Filter by project if specified
    if (project) {
      results = results.filter(o => o.project === project);
    }

    // Simple relevance scoring (matches Engram's FTS5 conceptually)
    if (query) {
      const terms = query.split(/\s+/).filter(Boolean);
      results = results
        .map(o => {
          let rank = 0;
          const searchable = `${o.title} ${o.content} ${o.type}`.toLowerCase();
          for (const term of terms) {
            if (searchable.includes(term)) rank += 1;
          }
          return { ...o, rank };
        })
        .filter(o => o.rank > 0)
        .sort((a, b) => b.rank - a.rank);
    } else {
      // No query: most recent first
      results.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    }

    results = results.slice(0, limit);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(results.map(r => ({
      id: r.id,
      title: r.title,
      content: r.content,
      type: r.type,
      scope: r.scope,
      topic_key: r.topic_key,
      project: r.project,
      metadata: r.metadata,
      rank: r.rank || 0,
      revision_count: r.revision_count,
      duplicate_count: r.duplicate_count,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }))));
    return;
  }

  // DELETE /observations/:id
  const deleteMatch = path.match(/^\/observations\/(.+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    const id = Number(deleteMatch[1]);
    const key = observations.has(id) ? id : deleteMatch[1];
    if (observations.has(key)) {
      observations.delete(key);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'deleted', id: key }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    }
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found', path }));
});

server.listen(PORT, () => {
  console.log(`[engram-stub] Listening on http://localhost:${PORT}`);
  console.log(`[engram-stub] Endpoints: POST /sessions, POST /observations, GET /observations/:id, GET /search, GET /health`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[engram-stub] Shutting down...');
  server.close(() => process.exit(0));
});
