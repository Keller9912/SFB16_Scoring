/**
 * fetch_sleeper.js
 * ---------------------------------------------------------------------------
 * Server-side companion to scripts/fetch_mfl.js, same idea applied to Sleeper.
 *
 * The ADP page used to crawl Sleeper live in the browser: fetch every
 * #SFB16 league for USER_ID, then fetch picks from every one of their
 * drafts one at a time, throttled 120ms apart to avoid rate limits, plus a
 * full players.json fetch (several MB) on every page load. With enough
 * leagues that made first load slow and inconsistent.
 *
 * This script does that same crawl server-side on a schedule instead, and
 * writes data/sleeper_picks.json — already resolved to name/pos/team and
 * shaped exactly like data/mfl_picks.json, so both sfb16_adp.html and
 * sfb16_draft_war_room.html can just fetch a static file for either platform.
 *
 * Run by .github/workflows/fetch-sleeper.yml on the same ~15 min cadence as
 * the MFL Action. Not truly "live" — it's "as of last Action run", same
 * caveat the MFL data already carries.
 *
 * Env vars:
 *   SLEEPER_USER_ID - the Sleeper user_id whose #SFB16 leagues get crawled
 *                      (defaults to the site's existing seed account)
 *   SEASON          - NFL season year to query (defaults to 2026)
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const SLEEPER_API = 'https://api.sleeper.app/v1';
const SEASON = process.env.SEASON || '2026';
// Same seed account already hardcoded as USER_ID in sfb16_adp.html.
const USER_ID = process.env.SLEEPER_USER_ID || '819245060922130432';
const VALID_POS = ['QB', 'RB', 'WR', 'TE', 'K'];

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_PATH = path.join(DATA_DIR, 'sleeper_picks.json');

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function main() {
  console.log(`Fetching #SFB16 leagues for Sleeper user_id ${USER_ID}, season ${SEASON}...`);

  const [leagues, allPlayers] = await Promise.all([
    getJSON(`${SLEEPER_API}/user/${USER_ID}/leagues/nfl/${SEASON}`),
    getJSON(`${SLEEPER_API}/players/nfl`),
  ]);

  const sfb16 = (leagues || []).filter((l) => l.name && l.name.includes('#SFB16'));
  console.log(`Found ${sfb16.length} #SFB16 league(s).`);

  const picks = [];
  let leaguesWithPicks = 0;

  for (const league of sfb16) {
    if (!league.draft_id) continue; // no draft started yet for this league
    let leaguePicks = [];
    try {
      leaguePicks = await getJSON(`${SLEEPER_API}/draft/${league.draft_id}/picks`);
    } catch (err) {
      console.warn(`Skipping league ${league.league_id} (${league.name}): ${err.message}`);
      continue;
    }
    if (!Array.isArray(leaguePicks) || !leaguePicks.length) continue;
    leaguesWithPicks++;

    for (const pick of leaguePicks) {
      if (!pick.player_id || !pick.pick_no) continue;
      const player = allPlayers[String(pick.player_id)];
      if (!player || !player.full_name) continue;
      const pos = player.position || '';
      if (!VALID_POS.includes(pos)) continue;

      picks.push({
        name: player.full_name,
        pos,
        team: player.team || '—',
        pick_no: pick.pick_no,
      });
    }
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    OUTPUT_PATH,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        leagues: sfb16.map((l) => ({ league_id: l.league_id, name: l.name, draft_id: l.draft_id || null })),
        picks,
      },
      null,
      2
    )
  );
  console.log(`Wrote ${picks.length} picks from ${leaguesWithPicks}/${sfb16.length} leagues to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
