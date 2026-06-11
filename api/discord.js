// ========== Vercel Serverless Function — Discord News Feed ==========
//
// Pulls the user's Discord server (agents post market updates there) into the
// platform, split by channel. The browser can't call Discord's API (CORS + the
// bot token must stay secret), so this proxies server-side.
//
//   /api/discord?mode=channels            → [{id, name, position}]   (text channels)
//   /api/discord?mode=feed&limit=15       → { channels:[{id,name,messages:[...]}] }
//
// Requires the DISCORD_BOT_TOKEN env var (a bot invited to the guild with
// View Channels + Read Message History, and the MESSAGE CONTENT intent enabled).
// Returns { error:'not_configured' } until the token is set.

const GUILD_ID = process.env.DISCORD_GUILD_ID || '1415375627200237659';
const TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const API = 'https://discord.com/api/v10';

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
}

async function dget(path) {
    const r = await fetch(`${API}${path}`, {
        headers: { Authorization: `Bot ${TOKEN}`, Accept: 'application/json' },
    });
    if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new Error(`Discord ${r.status}: ${body.slice(0, 120)}`);
    }
    return r.json();
}

// Slim a raw Discord message down to what the UI renders. Agent updates often
// arrive as EMBEDS (webhook posts), so embed title/description/fields are kept.
function slimMessage(m) {
    const embeds = (m.embeds || []).slice(0, 3).map(e => ({
        title: e.title || '',
        description: (e.description || '').slice(0, 900),
        url: e.url || '',
        fields: (e.fields || []).slice(0, 6).map(f => ({ name: f.name, value: String(f.value).slice(0, 300) })),
    })).filter(e => e.title || e.description || e.fields.length);
    return {
        id: m.id,
        author: (m.author && (m.author.global_name || m.author.username)) || 'bot',
        bot: !!(m.author && m.author.bot),
        ts: m.timestamp,
        content: (m.content || '').slice(0, 1200),
        embeds,
        attachments: (m.attachments || []).slice(0, 2).map(a => ({ url: a.url, name: a.filename })),
    };
}

module.exports = async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }

    if (!TOKEN) {
        res.setHeader('Cache-Control', 's-maxage=30');
        res.status(200).json({ error: 'not_configured', message: 'DISCORD_BOT_TOKEN is not set' });
        return;
    }

    try {
        const mode = req.query.mode || 'feed';

        // Text channels of the guild, in display order
        const all = await dget(`/guilds/${GUILD_ID}/channels`);
        const textChannels = all
            .filter(c => c.type === 0 || c.type === 5) // text + announcement
            .sort((a, b) => (a.position || 0) - (b.position || 0));

        if (mode === 'channels') {
            res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
            res.status(200).json(textChannels.map(c => ({ id: c.id, name: c.name, position: c.position })));
            return;
        }

        // FEED: recent messages for every text channel, in parallel.
        const limit = Math.min(parseInt(req.query.limit, 10) || 15, 25);
        const channels = await Promise.all(textChannels.slice(0, 12).map(async (c) => {
            try {
                const msgs = await dget(`/channels/${c.id}/messages?limit=${limit}`);
                return { id: c.id, name: c.name, messages: msgs.map(slimMessage) };
            } catch (e) {
                return { id: c.id, name: c.name, messages: [], error: 'no_access' };
            }
        }));

        // Near-real-time: tiny edge cache only absorbs bursts; the client polls.
        res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');
        res.status(200).json({ channels, asOf: new Date().toISOString() });
    } catch (e) {
        res.setHeader('Cache-Control', 's-maxage=15');
        res.status(502).json({ error: 'discord_failed', message: e.message });
    }
};
