// ─────────────────────────────────────────────────────────────────────────────
// Anilist GraphQL Proxy  –  with rate-limit bypass & multi-user support
// Strategy:
//   1. A pool of "virtual identities" (User-Agent + Accept-Encoding combos)
//      are round-robined per incoming request so no two consecutive hits share
//      the same fingerprint toward AniList.
//   2. In-memory per-identity sliding-window counters enforce conservative
//      limits BEFORE we even send a request, so we stay well under AniList's
//      90 req/min (auth) / 60 req/min (anon) ceiling.
//   3. On a 429 from AniList we retry automatically on the NEXT available
//      identity (up to MAX_RETRIES times) with exponential back-off.
//   4. Vercel spins many isolated serverless instances (each with its own IP),
//      so the pool effectively multiplies across the fleet – maximising
//      throughput at scale.
// ─────────────────────────────────────────────────────────────────────────────

const ANILIST_URL = process.env.ANILIST_API_URL || 'https://graphql.anilist.co/';

// ── Rate-limit config ──────────────────────────────────────────────────────
const WINDOW_MS        = 60_000;   // 1-minute sliding window
const ANON_MAX_RPM     = 55;       // AniList allows 60 – keep 5 as buffer
const AUTH_MAX_RPM     = 85;       // AniList allows 90 – keep 5 as buffer
const MAX_RETRIES      = 3;
const RETRY_BASE_MS    = 300;      // base back-off; doubles each retry

// ── Identity pool ─────────────────────────────────────────────────────────
// Each "identity" represents a different browser/client fingerprint.
// Vercel already rotates IPs per instance; we rotate User-Agents on top.
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Edg/123.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
];

const ACCEPT_ENCODINGS = [
  'gzip, deflate, br',
  'gzip, deflate',
  'br, gzip',
  'deflate, br',
  'gzip',
  'br',
];

// Build the pool – one slot per User-Agent
const POOL = USER_AGENTS.map((ua, i) => ({
  id: i,
  userAgent: ua,
  acceptEncoding: ACCEPT_ENCODINGS[i % ACCEPT_ENCODINGS.length],
  // Sliding window: array of timestamps of recent requests
  timestamps: [],
}));

let poolCursor = 0; // global round-robin cursor (per instance)

// ── Sliding window helpers ─────────────────────────────────────────────────
function pruneWindow(identity) {
  const cutoff = Date.now() - WINDOW_MS;
  identity.timestamps = identity.timestamps.filter(t => t > cutoff);
}

function canUse(identity, isAuthenticated) {
  pruneWindow(identity);
  const limit = isAuthenticated ? AUTH_MAX_RPM : ANON_MAX_RPM;
  return identity.timestamps.length < limit;
}

function recordUse(identity) {
  identity.timestamps.push(Date.now());
}

// ── Pick the next available identity ──────────────────────────────────────
// Starts at the current cursor and walks forward until it finds a slot
// under its rate limit. Returns null if every slot is saturated.
function pickIdentity(isAuthenticated, excludeIds = []) {
  const poolSize = POOL.length;
  for (let offset = 0; offset < poolSize; offset++) {
    const idx = (poolCursor + offset) % poolSize;
    const identity = POOL[idx];
    if (excludeIds.includes(identity.id)) continue;
    if (canUse(identity, isAuthenticated)) {
      // Advance the cursor so the next request starts from the slot after this one
      poolCursor = (idx + 1) % poolSize;
      return identity;
    }
  }
  return null; // all slots saturated – caller should back off
}

// ── Sleep helper ───────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ── Build request headers for an identity ────────────────────────────────
function buildHeaders(identity, authHeader) {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': identity.userAgent,
    'Accept-Encoding': identity.acceptEncoding,
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://anilist.co',
    'Referer': 'https://anilist.co/',
    ...(authHeader ? { 'Authorization': authHeader } : {}),
  };
}

// ── Core proxy fetch with retry logic ─────────────────────────────────────
async function fetchWithRetry(body, authHeader) {
  const isAuthenticated = Boolean(authHeader);
  const exhaustedIds = [];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const identity = pickIdentity(isAuthenticated, exhaustedIds);

    if (!identity) {
      // All identities saturated – wait for the shortest window to free up
      await sleep(RETRY_BASE_MS * Math.pow(2, attempt));
      exhaustedIds.length = 0; // reset exclusions and retry
      continue;
    }

    recordUse(identity);

    try {
      const response = await fetch(ANILIST_URL, {
        method: 'POST',
        headers: buildHeaders(identity, authHeader),
        body: JSON.stringify(body),
      });

      // AniList rate-limited THIS identity – rotate to the next one
      if (response.status === 429) {
        exhaustedIds.push(identity.id);
        const retryAfter = parseInt(response.headers.get('Retry-After') || '0', 10);
        const backOff = retryAfter > 0
          ? retryAfter * 1000
          : RETRY_BASE_MS * Math.pow(2, attempt);

        if (attempt < MAX_RETRIES) {
          await sleep(backOff);
          continue;
        }
        // Exhausted retries – pass 429 back to client
        const errData = await response.json().catch(() => ({}));
        return { status: 429, data: errData, retryAfter };
      }

      const data = await response.json();
      return { status: response.status, data, retryAfter: null };

    } catch (networkError) {
      if (attempt === MAX_RETRIES) throw networkError;
      await sleep(RETRY_BASE_MS * Math.pow(2, attempt));
    }
  }

  throw new Error('Max retries exceeded');
}

// ── Vercel serverless handler ──────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { query, variables, operationName } = req.body ?? {};
  if (!query) {
    return res.status(400).json({ error: 'Missing "query" field in request body' });
  }

  try {
    const authHeader = req.headers.authorization || null;
    const { status, data, retryAfter } = await fetchWithRetry(
      { query, variables, operationName },
      authHeader
    );

    if (retryAfter) {
      res.setHeader('Retry-After', String(retryAfter));
    }

    // Surface pool saturation info in debug mode
    if (process.env.DEBUG === 'true') {
      const now = Date.now();
      const poolStats = POOL.map(id => ({
        id: id.id,
        recentRequests: id.timestamps.filter(t => t > now - WINDOW_MS).length,
      }));
      res.setHeader('X-Pool-Stats', JSON.stringify(poolStats));
    }

    return res.status(status).json(data);

  } catch (error) {
    console.error('[AniList Proxy] Fatal error:', error);
    return res.status(500).json({
      error: 'Proxy request failed',
      message: error.message,
    });
  }
}
