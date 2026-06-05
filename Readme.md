# 🚀 Anilist GraphQL Proxy (AniProxy) v2

> A fast, CORS-enabled, **rate-limit-aware** serverless proxy for the Anilist GraphQL API.  
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
| Debug pool stats | ❌ | ✅ via `DEBUG=true` |

---

## 🧠 How the rate-limit bypass works

AniList enforces:
- **60 req/min** for anonymous requests
- **90 req/min** for authenticated requests

…**per IP address**. Vercel already rotates IPs across its serverless fleet. v2 adds a second layer:

### Identity Pool (per instance)

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
2. **Checks** whether that slot is still under the conservative per-minute limit (55 anon / 84 auth)
3. **Records** the timestamp in the slot's sliding window
4. **Sends** the request with that slot's headers

On a **429 from AniList**:
- Marks the slot as exhausted for this retry cycle
- Rotates to the **next non-exhausted slot**
- Applies exponential back-off (300ms → 600ms → 1200ms)
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

---

## 🚀 Quick Deploy

```bash
# 1. Clone
git clone 
cd 

# 2. Install
npm install

# 3. Deploy
npm run deploy
```

Or click [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FItzmepromgitman%2FAnilist-Api)

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
```

### Authenticated Request

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

Create `.env.local` for local dev, or set in Vercel project settings:

| Variable | Default | Description |
|---|---|---|
| `ANILIST_API_URL` | `https://graphql.anilist.co/` | AniList API URL |
| `DEBUG` | `false` | Set to `true` to expose `X-Pool-Stats` response header with per-slot counters |

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
| Authenticated | 90 req/min | 84 req/min |

With 6 pool slots per instance, effective capacity per instance is up to **330 anon / 504 auth req/min** before any 429 is expected.

---

## 📄 License

MIT
