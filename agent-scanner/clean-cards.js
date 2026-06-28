// One-off: strip ALL nikud + replace "חישה" → "זיהוי" on every active catalyst card.
// Deterministic, no Gemini — guarantees the existing cards match the user's requirement instantly.
//   node clean-cards.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
try { if (!globalThis.WebSocket) globalThis.WebSocket = require('ws'); } catch (e) { }

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const SECRET = process.env.AGENT_WRITE_SECRET;
const clean = (s) => s == null ? s : String(s).replace(/[֑-ׇ]/g, '').replace(/חישה/g, 'זיהוי').replace(/[ \t]{2,}/g, ' ').trim();

(async () => {
  const { data, error } = await sb.from('catalyst_cards').select('*').eq('status', 'active');
  if (error) { console.error('select error:', error.message); process.exit(1); }
  console.log(`Cleaning ${data.length} active cards…`);
  let changed = 0;
  for (const c of data) {
    const patch = {
      sector_name: clean(c.sector_name),
      thesis: clean(c.thesis),
      tech_layer: clean(c.tech_layer),
      supply_layer: clean(c.supply_layer),
      talent_layer: clean(c.talent_layer),
      stealth_targets: Array.isArray(c.stealth_targets) ? c.stealth_targets.map(t => ({ ...t, why: clean(t.why) })) : c.stealth_targets,
    };
    const wasChanged = patch.sector_name !== c.sector_name || patch.thesis !== c.thesis;
    const { error: uerr } = await sb.rpc('update_catalyst_card', { p_secret: SECRET, p_id: c.id, p_patch: patch });
    if (uerr) console.log(`  ${c.id} ERR: ${uerr.message}`);
    else { if (wasChanged) changed++; console.log(`  ${c.id}: ${patch.sector_name.slice(0, 50)}`); }
  }
  console.log(`Done. ${changed} cards had nikud/חישה removed.`);
  process.exit(0);
})();
