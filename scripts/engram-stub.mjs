/**
 * Engram Stub Server
 *
 * Mock HTTP API matching real Engram endpoints for development.
 * Runs on port 4199 by default (ENGRAM_STUB_PORT env var).
 *
 * Endpoints:
 *   POST /observations       — save an insight
 *   GET  /search             — search memory
 *   GET  /health             — health check
 *   DELETE /observations/:id — delete an observation
 *
 * Usage:
 *   node scripts/engram-stub.mjs
 *   ENGRAM_STUB_PORT=5000 node scripts/engram-stub.mjs
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = parseInt(process.env.ENGRAM_STUB_PORT || '4199', 10);

// In-memory store (matches Engram's SQLite persistence conceptually)
const observations = new Map();

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

  // POST /observations — save insight
  if (path === '/observations' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const id = data.id || randomUUID();

        // Deduplication: if deduplication_key exists, update instead of insert
        let existingId = null;
        if (data.deduplication_key) {
          for (const [obsId, obs] of observations) {
            if (obs.deduplication_key === data.deduplication_key) {
              existingId = obsId;
              break;
            }
          }
        }

        const observation = {
          id: existingId || id,
          title: data.title || 'Untitled',
          content: data.content || '',
          type: data.type || 'discovery',
          scope: data.scope || 'project',
          topic_key: data.topic_key || null,
          project: data.project || null,
          deduplication_key: data.deduplication_key || null,
          metadata: data.metadata || {},
          created_at: existingId
            ? observations.get(existingId).created_at
            : new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        observations.set(observation.id, observation);

        res.writeHead(existingId ? 200 : 201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: observation.id,
          status: existingId ? 'updated' : 'created',
          deduplication_key: observation.deduplication_key,
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // GET /search — search memory
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
          let score = 0;
          const searchable = `${o.title} ${o.content} ${o.type}`.toLowerCase();
          for (const term of terms) {
            if (searchable.includes(term)) score += 1;
          }
          return { ...o, score };
        })
        .filter(o => o.score > 0)
        .sort((a, b) => b.score - a.score);
    } else {
      // No query: return most recent
      results.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    }

    results = results.slice(0, limit);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      results: results.map(r => ({
        id: r.id,
        title: r.title,
        content: r.content,
        type: r.type,
        scope: r.scope,
        topic_key: r.topic_key,
        project: r.project,
        metadata: r.metadata,
        score: r.score || 0,
        created_at: r.created_at,
        updated_at: r.updated_at,
      })),
      total: results.length,
    }));
    return;
  }

  // DELETE /observations/:id
  const deleteMatch = path.match(/^\/observations\/(.+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    const id = deleteMatch[1];
    if (observations.has(id)) {
      observations.delete(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'deleted', id }));
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
  console.log(`[engram-stub] Endpoints: POST /observations, GET /search, GET /health`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[engram-stub] Shutting down...');
  server.close(() => process.exit(0));
});
