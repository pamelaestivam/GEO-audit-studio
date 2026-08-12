# GEO Audit Studio

An AI Search Audit & Remediation Platform for **Generative Engine Optimization (GEO)**.
It tests real buyer-intent search queries against live AI search engines (Gemini,
ChatGPT, Perplexity, Claude, SearchGPT), reports how each one describes your brand,
flags hallucinated/inaccurate claims and omissions, and produces a prioritized
remediation plan.

## How it gets real data

The Express backend (`server.ts`) calls the **Gemini API with live Google Search
grounding** (`@google/genai`, model `gemini-3.6-flash`) to:

- Auto-detect a business's domain, industry, offerings, and competitors from a
  URL or brand name (`POST /api/audit/parse-url`)
- Generate real, high-intent buyer queries for a business (`POST /api/audit/generate-queries`)
- Run a grounded web search for each query and derive live citation URLs, then use
  those citations/grounding metadata to score how each AI search engine represents
  the brand (`POST /api/audit/run`, `POST /api/audit/evaluate-query`)
- Programmatically compute the GEO Visibility Score, Share of Voice, and Leader
  Share directly from the live grounding results (not left to the model to invent)

If `GEMINI_API_KEY` is not configured, the backend returns an explicit
"insufficient data" result instead of fabricating metrics — no data is faked in
place of real API calls.

## Run Locally

**Prerequisites:** Node.js 20+

1. Install dependencies:
   ```
   npm install
   ```
2. Copy `.env.example` to `.env.local` and set `GEMINI_API_KEY` to your
   [Gemini API key](https://aistudio.google.com/app/apikey):
   ```
   cp .env.example .env.local
   ```
3. Run the app:
   ```
   npm run dev
   ```
   The app is served at `http://localhost:3000` (Express + Vite middleware).

## Build for production

```
npm run build
npm start
```

## Notes

- Auth is a lightweight in-memory demo (any email/password auto-registers a
  session) — swap `usersDb` in `server.ts` for a real database before deploying.
- `npm run lint` runs `tsc --noEmit` for type checking.
