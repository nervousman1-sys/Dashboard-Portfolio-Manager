# Twitter/X → Gemini data pipeline

Tracks a list of X (Twitter) usernames and returns their latest tweets as clean JSON, ready to feed
a Gemini agent as **context** or a **Function Tool** result.

Two ways it ships:

1. **Live in the platform** — folded into `api/news.js` (Vercel is at its 12-function cap):
   `GET /api/news?twitter=1[&users=elonmusk,YahooFinance][&limit=5][&since=<ISO>]`
   It also drives the **"X (טוויטר)" tab** inside the "חדשות כלכלה ושוק ההון" page.

2. **Standalone** — [`index.js`](index.js): drop into any Cloud Function / Node service (e.g. next to
   your Gemini agent on the VPS). `require('./index').fetchLatestTweets([...])`.

## Environment variables

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `RAPIDAPI_KEY` | ✅ | — | Your RapidAPI key. Sent only in the request **header** (never the URL). Server-side only. |
| `RAPIDAPI_TWITTER_HOST` | — | `twitter-api45.p.rapidapi.com` | Swap providers (e.g. Twitter Y2S) here. |
| `RAPIDAPI_TWITTER_PATH` | — | `/timeline.php?screenname={user}` | `{user}` is URL-encoded and substituted. |

Set it on Vercel: `npx vercel env add RAPIDAPI_KEY production` (then redeploy). On the VPS: add it to the
service's `.env`. **Never commit the key or put it in `NEXT_PUBLIC_*` / the client.**

## Output JSON (feed this to Gemini)

```json
{
  "tweets": [
    { "id": "1811234567890", "user": "elonmusk", "date": "2026-07-18T12:34:56.000Z", "text": "clean tweet text, links stripped" }
  ],
  "accounts": ["elonmusk", "YahooFinance"],
  "count": 42,
  "asOf": "2026-07-18T13:00:00.000Z"
}
```

Each tweet is minimal on purpose — **id, user, date (ISO), text** — deduped by id and sorted
newest-first. Pass `since=<ISO>` (or `sinceIso`) to get **only new** tweets since your last poll.

### Gemini Function Tool declaration (example)

```json
{
  "name": "get_market_tweets",
  "description": "Latest tweets from tracked market accounts (id, user, date, text).",
  "parameters": {
    "type": "object",
    "properties": {
      "users": { "type": "string", "description": "comma-separated usernames (optional)" },
      "since": { "type": "string", "description": "ISO timestamp — only tweets after it (optional)" }
    }
  }
}
```
The tool implementation just does `GET https://www.finextium.com/api/news?twitter=1&...` and returns the JSON.
