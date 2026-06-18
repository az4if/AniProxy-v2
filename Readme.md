# 🚀 Anilist GraphQL Proxy (AniProxy) v2

> A fast, CORS-enabled, **rate-limit-aware** serverless proxy for the Anilist GraphQL API with **Upstash Redis caching**.  
> Deployable on Vercel in seconds — built for real concurrent traffic, not just local demos.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Faz4if%2FAniProxy)

---

## ✨ What's new in v2

| Feature | v1 | v2 |
|---|---|---|
| CORS support | ✅ | ✅ |
| Auth header forwarding | ✅ | ✅ |
| Rate-limit handling | ❌ passthrough | ✅ proactive bypass |
| Multi-user concurrency | ❌ single identity | ✅ identity pool (6 slots) |
| Automatic 429 retry | ❌ | ✅ up to 3 retries |
| Exponential back-off | ❌ | ✅ |
| Sliding-window counters | ❌ | ✅ per-slot, 60-second window |
| **Upstash Redis cache** | ❌ | ✅ anonymous queries cached server-side |
| Cache headers | ❌ | ✅ `X-Cache: HIT` / `MISS` |
| Debug pool stats | ❌ | ✅ via `DEBUG=true` |

---

## 🧠 How it works

### Identity Pool (per instance)

AniList enforces:
- **60 req/min** for anonymous requests
- **90 req/min** for authenticated requests

…**per IP address**. Vercel already rotates IPs across its serverless fleet. v2 adds a second layer:

Each Vercel function instance maintains a **pool of 6 virtual client identities**, each with a distinct `User-Agent` and `Accept-Encoding` fingerprint:

```
Pool slot 0 → Chrome / Windows   → tracks its own sliding-window counter
Pool slot 1 → Safari / macOS     → tracks its own sliding-window counter
Pool slot 2 → Firefox / Linux    → tracks its own sliding-window counter
Pool slot 3 → Edge / Windows     → tracks its own sliding-window counter
Pool slot 4 → Safari / iPhone    → tracks its own sliding-window counter
Pool slot 5 → Chrome / Android   → tracks its own sliding-window counter
```

Every incoming request:
1. **Round-robins** through the pool to pick the next available slot
2. **Checks** whether that slot is still under the conservative per-minute limit (55 anon / 85 auth)
3. **Records** the timestamp in the slot's sliding window
4. **Sends** the request with that slot's headers

On a **429 from AniList**:
- Marks the slot as exhausted for this retry cycle
- Rotates to the **next non-exhausted slot**
- Applies exponential back-off (300 ms → 600 ms → 1 200 ms)
- Retries up to **3 times** before surfacing the 429 to the client

### Why this works at scale on Vercel

```
User traffic
     │
     ▼
Vercel Edge (load-balanced across N instances, each with its own IP)
     │
     ├── Instance A (IP: 76.76.x.x) → Pool [UA-0..UA-5]
     ├── Instance B (IP: 76.76.y.y) → Pool [UA-0..UA-5]
     └── Instance C (IP: 76.76.z.z) → Pool [UA-0..UA-5]
             │
             ▼
     AniList GraphQL API
```

Each instance × 6 pool slots × Vercel's IP rotation = **massively higher effective throughput** before a single 429 is ever seen.

### Upstash Redis caching

Anonymous GraphQL **queries** are cached in Upstash Redis, reducing upstream hits even further:

```
Incoming request
      │
      ▼
 Authenticated or mutation?
      ├── yes → forward via identity pool (no cache)
      └── no  → compute cache key (djb2 hash of query + variables + operationName)
                     │
                     ├── Redis HIT  → return cached response  (X-Cache: HIT)
                     └── Redis MISS → fetch via identity pool, store in Redis, return
                                                               (X-Cache: MISS)
```

Cache entries expire after `CACHE_TTL_SECONDS` (default **5 minutes**). Cache errors are non-fatal — the request falls through to AniList transparently.

---

## 🚀 Quick Deploy

```bash
# 1. Clone
git clone https://github.com/az4if/AniProxy
cd AniProxy

# 2. Install
npm install

# 3. Copy env vars and fill in your Upstash credentials
cp .env.example .env.local

# 4. Deploy
npm run deploy
```

Or click [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Faz4if%2FAniProxy)

---

## 📍 API Endpoints

| Endpoint | Description |
|---|---|
| `POST /api/graphql` | Main GraphQL proxy endpoint |
| `POST /graphql` | Short alias |

---

## 📖 Usage

### Basic Query

```javascript
const response = await fetch('https://your-app.vercel.app/api/graphql', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: `query ($id: Int) {
      Media(id: $id, type: ANIME) {
        id
        title { romaji english }
        episodes
        status
        averageScore
      }
    }`,
    variables: { id: 15125 }
  })
});
const data = await response.json();
// Check response.headers.get('X-Cache') → 'HIT' or 'MISS'
```

### Authenticated Request (cache bypassed)

```javascript
const response = await fetch('https://your-app.vercel.app/api/graphql', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer YOUR_ACCESS_TOKEN'
  },
  body: JSON.stringify({ query: `query { Viewer { id name } }` })
});
```

---

## 🛠️ Environment Variables

Copy `.env.example` to `.env.local` for local dev, or set these in your Vercel project settings:

| Variable | Default | Required | Description |
|---|---|---|---|
| `PORT` | `3000` | No | Port for `vercel dev` (ignored in production) |
| `ANILIST_API_URL` | `https://graphql.anilist.co/` | No | AniList upstream URL |
| `UPSTASH_REDIS_REST_URL` | — | **Yes** | Upstash Redis REST endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | — | **Yes** | Upstash Redis REST token |
| `CACHE_TTL_SECONDS` | `300` | No | Cache expiry in seconds (default 5 min) |
| `DEBUG` | `false` | No | Set `true` to expose `X-Pool-Stats` header |

### Getting Upstash credentials

1. Sign up at [console.upstash.com](https://console.upstash.com) (free tier available)
2. Create a new **Redis** database
3. Open the database → **REST API** tab
4. Copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` into your env

### Debug mode

With `DEBUG=true`, every response includes:

```
X-Pool-Stats: [{"id":0,"recentRequests":12},{"id":1,"recentRequests":8}, ...]
```

Useful for monitoring pool utilisation under load.

---

## 🚨 Error Responses

| Status | Meaning |
|---|---|
| 400 | Missing `query` in request body |
| 405 | Non-POST request |
| 429 | All pool slots exhausted after retries; includes `Retry-After` header |
| 500 | Upstream network failure |

---

## 📈 Rate Limits

AniList's limits (proxy stays safely below):

| Mode | AniList Limit | Proxy limit per slot |
|---|---|---|
| Anonymous | 60 req/min | 55 req/min |
| Authenticated | 90 req/min | 85 req/min |

With 6 pool slots per instance, effective capacity per instance is up to **330 anon / 510 auth req/min** before any 429 is expected. With Upstash caching enabled, most anonymous traffic is served from Redis and never counts against these limits at all.

---

## 📄 License

MIT
