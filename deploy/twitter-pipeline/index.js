// ============================================================================
// Finextium — Twitter/X → Gemini Data Pipeline (standalone Cloud Function / Node.js)
// ----------------------------------------------------------------------------
// Tracks a predefined list of X (Twitter) usernames and returns their latest tweets,
// cleaned to a compact JSON shape that drops straight into a Gemini prompt as CONTEXT
// or as a Function Tool result.
//
// ── Architecture (per spec) ──
//   • NOT the official X API (paid), NOT direct scraping (blocked).
//   • A popular third-party RapidAPI provider via a plain HTTP GET.
//   • Default provider: twitter-api45  (GET /timeline.php?screenname=USER) — cheap + reliable.
//     Swap to another (e.g. "Twitter Y2S") by setting RAPIDAPI_TWITTER_HOST + RAPIDAPI_TWITTER_PATH.
//
// ── Environment variables ──
//   RAPIDAPI_KEY            (required)  your RapidAPI key
//   RAPIDAPI_TWITTER_HOST   (optional)  default 'twitter-api45.p.rapidapi.com'
//   RAPIDAPI_TWITTER_PATH   (optional)  default '/timeline.php?screenname={user}' ({user} is substituted)
//
// ── Run ──
//   RAPIDAPI_KEY=xxxx node index.js                 # prints clean JSON for the default accounts
//   const { fetchLatestTweets } = require('./index'); await fetchLatestTweets(['elonmusk']);
//   Also exports a Vercel/GCF-style handler:  module.exports.handler(req, res)
//
// Node 18+ (global fetch). No dependencies.
// ============================================================================

'use strict';

// The accounts to follow — edit freely.
const TWITTER_ACCOUNTS = ['elonmusk', 'YahooFinance', 'DeItaone', 'unusual_whales', 'FinancialJuice'];

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = process.env.RAPIDAPI_TWITTER_HOST || 'twitter-api45.p.rapidapi.com';
const RAPIDAPI_PATH = process.env.RAPIDAPI_TWITTER_PATH || '/timeline.php?screenname={user}';

// Strip t.co/other short links, decode HTML entities, collapse whitespace → clean text for the LLM.
function cleanTweetText(raw) {
    return String(raw || '')
        .replace(/https?:\/\/t\.co\/\S+/gi, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
}

// SECURE FETCH: the key travels only in the request header (never in the URL/logs), server-side only.
async function fetchUserTweets(username, limit = 5) {
    const user = String(username).trim().replace(/^@/, '');
    const path = RAPIDAPI_PATH.includes('{user}')
        ? RAPIDAPI_PATH.replace('{user}', encodeURIComponent(user))
        : RAPIDAPI_PATH + encodeURIComponent(user);
    const url = `https://${RAPIDAPI_HOST}${path}`;

    let json = null;
    try {
        const resp = await fetch(url, {
            headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': RAPIDAPI_HOST, Accept: 'application/json' },
        });
        if (!resp.ok) return [];
        json = await resp.json();
    } catch (e) { return []; }

    // Defensive parse — providers nest the array differently (timeline / tweets / results / data).
    const arr = (json && (json.timeline || json.tweets || json.results ||
        (json.data && (json.data.tweets || json.data)) || (Array.isArray(json) ? json : []))) || [];

    const out = [];
    for (const item of (Array.isArray(arr) ? arr : [])) {
        if (!item || typeof item !== 'object') continue;
        const src = (item.tweet && typeof item.tweet === 'object') ? item.tweet : item;
        const id = String(src.tweet_id || src.id_str || src.rest_id || src.id || '');
        const text = cleanTweetText(src.text || src.full_text || src.content || '');
        const rawDate = src.created_at || src.date || src.time || null;
        let date = null; if (rawDate) { const d = new Date(rawDate); if (!isNaN(d)) date = d.toISOString(); }
        const uname = src.screen_name || (src.author && src.author.screen_name) ||
            (src.user && (src.user.screen_name || src.user.username)) || user;
        if (id && text && text.length > 1) out.push({ id, user: uname, date, text });
        if (out.length >= limit) break;
    }
    return out;
}

// MAIN: pull the latest tweets for a list of users → deduped, newest-first, clean JSON.
// `sinceIso` (optional) returns ONLY tweets newer than that timestamp (for polling loops).
async function fetchLatestTweets(usernames = TWITTER_ACCOUNTS, { perUser = 5, sinceIso = null } = {}) {
    if (!RAPIDAPI_KEY) return { error: 'not_configured', message: 'RAPIDAPI_KEY is not set', tweets: [] };
    const users = usernames.map(u => String(u).trim().replace(/^@/, '')).filter(Boolean).slice(0, 12);
    const sinceMs = sinceIso ? Date.parse(sinceIso) : 0;

    const batches = await Promise.allSettled(users.map(u => fetchUserTweets(u, perUser)));
    let tweets = [];
    for (const b of batches) if (b.status === 'fulfilled' && Array.isArray(b.value)) tweets = tweets.concat(b.value);

    const seen = new Set();
    tweets = tweets
        .filter(t => {
            if (!t.id || seen.has(t.id)) return false; seen.add(t.id);   // dedup
            if (sinceMs && t.date && Date.parse(t.date) <= sinceMs) return false; // only NEW
            return true;
        })
        .sort((a, b) => (Date.parse(b.date || 0) || 0) - (Date.parse(a.date || 0) || 0))
        .slice(0, 80);

    return { tweets, accounts: users, count: tweets.length, asOf: new Date().toISOString() };
}

// Cloud-Function / Vercel-style handler: GET ?users=a,b&limit=5&since=ISO → the JSON above.
async function handler(req, res) {
    const q = (req && req.query) || {};
    const users = q.users ? String(q.users).split(',') : TWITTER_ACCOUNTS;
    const result = await fetchLatestTweets(users, { perUser: Math.min(+q.limit || 5, 15), sinceIso: q.since || null });
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(result);
}

module.exports = { TWITTER_ACCOUNTS, fetchLatestTweets, fetchUserTweets, cleanTweetText, handler };

// Standalone run: `RAPIDAPI_KEY=xxx node index.js`
if (require.main === module) {
    fetchLatestTweets().then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e); process.exit(1); });
}
