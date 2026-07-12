/**
 * fetch_sleeper_adp.js
 * ---------------------------------------------------------------------------
 * Server-side companion to scripts/fetch_mfl.js.
 *
 * Crawls Sleeper for every #SFB16 league/draft belonging to a configured
 * "seed" account (SLEEPER_USERNAME), pulls every pick from every draft it
 * finds, and merges those picks with the existing data/mfl_picks.json
 * (already produced on its own ~15 min schedule by fetch_mfl.js) into one
 * shared file: data/adp_summary.json.
 *
 * data/adp_summary.json is the single ADP source read by BOTH:
 *   - sfb16_adp.html (the existing ADP tool)
 *   - sfb16_draft_war_room.html (the new draft-day tool)
 *
 * Run by .github/workflows/fetch-sleeper-adp.yml on the same ~15 min cadence
 * as the MFL Action. Not truly "live" - it's "as of last Action run", same
 * caveat as MFL picks already carry.
 *
 * Env vars:
 *   SLEEPER_USERNAME  - the Sleeper username whose #SFB16 leagues we crawl
 *   SEASON            - NFL season year to query (defaults to 2026)
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const SLEEPER_API = 'https://api.sleeper.app/v1';
const SEASON = process.env.SEASON || '2026';
const SEED_USERNAME = process.env.SLEEPER_USERNAME;

const DATA_DIR = path.join(__dirname, 'data');
const MFL_PICKS_PATH = path.join(DATA_DIR, 'mfl_picks.json');
const OUTPUT_PATH = path.join(DATA_DIR, 'adp_summary.json');

// ---- helpers ---------------------------------------------------------------

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status}`);
  }
  return res.json();
}

// Same normalization contract used by sfb16_adp.html's normName()/findProj():
// lowercase, strip punctuation/suffixes, collapse whitespace.
function normName(raw) {
  if (!raw) return '';
  return raw
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/'/g, '')
    .replace(/-/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stddev(arr, avg) {
  if (arr.length < 2) return 0;
  const variance = mean(arr.map((v) => (v - avg) ** 2));
  return Math.sqrt(variance);
}

// ---- Sleeper crawl -----------------------------------------------------

async function findSfb16Drafts(username) {
  const user = await getJSON(`${SLEEPER_API}/user/${encodeURIComponent(username)}`);
  if (!user || !user.user_id) {
    throw new Error(`Sleeper user "${username}" not found`);
  }

  const leagues = await getJSON(
    `${SLEEPER_API}/user/${user.user_id}/leagues/nfl/${SEASON}`
  );
  const sfbLeagues = (leagues || []).filter((lg) =>
    (lg.name || '').toUpperCase().includes('#SFB16')
  );

  const drafts = [];
  for (const league of sfbLeagues) {
    let leagueDrafts = [];
    try {
      leagueDrafts = await getJSON(`${SLEEPER_API}/league/${league.league_id}/drafts`);
    } catch (err) {
      console.warn(`Skipping league ${league.league_id} (${league.name}): ${err.message}`);
      continue;
    }
    for (const d of leagueDrafts || []) {
      drafts.push({ draft_id: d.draft_id, league_id: league.league_id, league_name: league.name });
    }
  }
  return drafts;
}

async function collectSleeperPicks(drafts) {
  // player key -> array of overall pick numbers, plus display name/pos/team
  const byPlayer = new Map();

  for (const d of drafts) {
    let picks = [];
    try {
      picks = await getJSON(`${SLEEPER_API}/draft/${d.draft_id}/picks`);
    } catch (err) {
      console.warn(`Skipping draft ${d.draft_id} (${d.league_name}): ${err.message}`);
      continue;
    }

    for (const pick of picks || []) {
      const meta = pick.metadata || {};
      const fullName = `${meta.first_name || ''} ${meta.last_name || ''}`.trim();
      if (!fullName || !pick.pick_no) continue;

      const key = normName(fullName) + '|' + (meta.position || '').toUpperCase();
      if (!byPlayer.has(key)) {
        byPlayer.set(key, {
          name: fullName,
          position: (meta.position || '').toUpperCase(),
          team: meta.team || '',
          picks: [],
        });
      }
      byPlayer.get(key).picks.push(pick.pick_no);
    }
  }

  return byPlayer;
}

// ---- merge with existing MFL picks -----------------------------------------

function loadMflPicks() {
  try {
    const raw = fs.readFileSync(MFL_PICKS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    // Expected shape produced by fetch_mfl.js: array of
    // { name, position, team, overall_pick } (one row per pick)
    return Array.isArray(parsed) ? parsed : parsed.picks || [];
  } catch (err) {
    console.warn(`No usable mfl_picks.json found (${err.message}) - continuing Sleeper-only`);
    return [];
  }
}

function buildSummary(sleeperByPlayer, mflPicks) {
  // key -> { name, position, team, picks: { Sleeper: [...], MFL: [...] } }
  const merged = new Map();

  for (const [key, entry] of sleeperByPlayer.entries()) {
    merged.set(key, {
      name: entry.name,
      position: entry.position,
      team: entry.team,
      picks: { Sleeper: entry.picks.slice(), MFL: [] },
    });
  }

  for (const row of mflPicks) {
    const name = row.name || row.player || '';
    const position = (row.position || row.pos || '').toUpperCase();
    const overall = row.overall_pick || row.pick_no || row.overall;
    if (!name || !overall) continue;

    const key = normName(name) + '|' + position;
    if (!merged.has(key)) {
      merged.set(key, {
        name,
        position,
        team: row.team || '',
        picks: { Sleeper: [], MFL: [] },
      });
    }
    merged.get(key).picks.MFL.push(overall);
  }

  const summary = [];
  for (const entry of merged.values()) {
    const all = [...entry.picks.Sleeper, ...entry.picks.MFL];
    if (all.length === 0) continue;
    const avg = mean(all);

    let platformLabel = 'Sleeper';
    if (entry.picks.Sleeper.length && entry.picks.MFL.length) platformLabel = 'Both';
    else if (entry.picks.MFL.length) platformLabel = 'MFL';

    summary.push({
      name: entry.name,
      position: entry.position,
      team: entry.team,
      adp: Number(avg.toFixed(2)),
      min: Math.min(...all),
      max: Math.max(...all),
      stddev: Number(stddev(all, avg).toFixed(2)),
      count: all.length,
      platforms: {
        Sleeper: entry.picks.Sleeper.length,
        MFL: entry.picks.MFL.length,
      },
      platformLabel,
    });
  }

  summary.sort((a, b) => a.adp - b.adp);
  return summary;
}

// ---- main -------------------------------------------------------------

async function main() {
  if (!SEED_USERNAME) {
    console.error('SLEEPER_USERNAME env var is required. Set it as a repo secret/variable.');
    process.exit(1);
  }

  console.log(`Crawling #SFB16 drafts for Sleeper user "${SEED_USERNAME}", season ${SEASON}...`);
  const drafts = await findSfb16Drafts(SEED_USERNAME);
  console.log(`Found ${drafts.length} #SFB16 draft(s) across Sleeper.`);

  const sleeperByPlayer = await collectSleeperPicks(drafts);
  const mflPicks = loadMflPicks();
  const summary = buildSummary(sleeperByPlayer, mflPicks);

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    OUTPUT_PATH,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        source_drafts: drafts.length,
        player_count: summary.length,
        players: summary,
      },
      null,
      2
    )
  );
  console.log(`Wrote ${summary.length} players to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
