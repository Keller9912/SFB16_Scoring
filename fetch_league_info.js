#!/usr/bin/env node
/**
 * fetch_league_info.js
 * ---------------------------------------------------------------------------
 * Server-side companion to fetch_mfl.js / fetch_sleeper.js / fetch_sleeper_adp.js.
 *
 * Crawls BOTH MFL and Sleeper for every #SFB16 league and writes one static
 * reference dataset — data/leagues.json — containing, per league:
 *   - league id and name
 *   - each team's name (and username, where the platform exposes one)
 *   - each team's draft position (draft slot / pick order)
 *   - whether the draft is complete
 *
 * This is NOT the ADP/picks pipeline (that stays in fetch_mfl.js /
 * fetch_sleeper.js / fetch_sleeper_adp.js). This is a league directory meant
 * to be a stable reference other tools/sites can look up (e.g. "what's the
 * draft position for team X in league Y", "is this league's draft done").
 *
 * Platform differences worth knowing about (both are handled below, but the
 * shapes aren't 1:1):
 *   - MFL does not reliably expose an owner's login/username for franchises
 *     you don't control. Only the team (franchise) name is guaranteed public.
 *     owner_name is included when MFL happens to return it, otherwise null.
 *   - MFL has no explicit "draft complete" flag, so it's inferred: complete
 *     when total picks made >= rosterSize * franchise count (bestball drafts
 *     only fill via the draft, so rosterSize == total draft rounds).
 *   - Sleeper gives a real username (display_name), an optional custom team
 *     name (metadata.team_name), an explicit draft "status", and a
 *     draft_order map (user_id -> draft slot) once the draft has started.
 *
 * Env vars:
 *   SEASON             - NFL season year to query (defaults to 2026)
 *   SLEEPER_USER_ID    - Sleeper seed account user_id to crawl leagues from
 *   SLEEPER_USERNAME   - fallback seed account username if no user_id set
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const YEAR = process.env.SEASON || '2026';
const MFL_BASE = `https://api.myfantasyleague.com/${YEAR}/export`;
const LEAGUE_NAME_RE = /^#SFB16(?:\s|-|$)/i;
const MFL_THROTTLE_MS = 250;

const SLEEPER_API = 'https://api.sleeper.app/v1';
const SLEEPER_SEED_USER_ID = process.env.SLEEPER_USER_ID || '819245060922130432';
const SLEEPER_SEED_USERNAME = process.env.SLEEPER_USERNAME;
const SLEEPER_THROTTLE_MS = 150;

const DATA_DIR = path.join(__dirname, 'data');
const OUTPUT_PATH = path.join(DATA_DIR, 'leagues.json');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function toArray(x) { return x == null ? [] : (Array.isArray(x) ? x : [x]); }

async function getJSON(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

// ---- MFL ---------------------------------------------------------------

async function fetchMflJson(url) {
  return getJSON(url, { headers: { 'User-Agent': 'SFB16-LeagueInfo-Bot/1.0' } });
}

async function findMflLeagues() {
  const searchData = await fetchMflJson(`${MFL_BASE}?TYPE=leagueSearch&SEARCH=SFB16&JSON=1`);
  return toArray(searchData?.leagues?.league).filter((lg) =>
    lg && lg.id && lg.name && LEAGUE_NAME_RE.test(lg.name) &&
    (lg.year === undefined || String(lg.year) === String(YEAR))
  );
}

async function fetchMflLeagueInfo(leagueId) {
  const [leagueData, draftData] = await Promise.all([
    fetchMflJson(`${MFL_BASE}?TYPE=league&L=${leagueId}&JSON=1`),
    fetchMflJson(`${MFL_BASE}?TYPE=draftResults&L=${leagueId}&JSON=1`),
  ]);

  const franchises = toArray(leagueData?.league?.franchises?.franchise);
  const rosterSize = parseInt(leagueData?.league?.rosterSize, 10) || null;

  const units = toArray(draftData?.draftResults?.draftUnit);
  const allPicks = [];
  units.forEach((u) => toArray(u.draftPick).forEach((p) => allPicks.push(p)));

  // Round-1 pick order gives each franchise's draft position (pick-within-round
  // for round 1 == overall draft slot). Falls back gracefully if round 1
  // isn't findable (e.g. draft not started yet).
  const round1 = allPicks.filter((p) => parseInt(p.round, 10) === 1);
  const draftPositionByFranchise = {};
  round1.forEach((p) => {
    const pos = parseInt(p.pick, 10);
    if (p.franchise && !isNaN(pos)) draftPositionByFranchise[p.franchise] = pos;
  });

  const franchiseCount = franchises.length || new Set(allPicks.map((p) => p.franchise)).size || 0;
  const totalPicksMade = allPicks.filter((p) => p.player).length;
  const expectedTotalPicks = rosterSize && franchiseCount ? rosterSize * franchiseCount : null;
  const draftComplete = expectedTotalPicks != null
    ? totalPicksMade >= expectedTotalPicks
    : (round1.length > 0 && totalPicksMade > 0 ? null : false); // unknown vs clearly-not-started

  const teams = franchises.map((f) => ({
    franchise_id: f.id,
    team_name: f.name || null,
    owner_name: f.owner_name || null, // only present when MFL exposes it (commissioner view)
    draft_position: draftPositionByFranchise[f.id] ?? null,
  }));

  return {
    league_id: leagueId,
    league_name: leagueData?.league?.name || null,
    roster_size: rosterSize,
    draft_complete: draftComplete,
    teams,
  };
}

async function collectMflLeagueInfo() {
  console.log('Searching MFL for #SFB16 leagues...');
  const leagues = await findMflLeagues();
  console.log(`Found ${leagues.length} MFL #SFB16 leagues`);

  const results = [];
  for (const lg of leagues) {
    try {
      const info = await fetchMflLeagueInfo(lg.id);
      results.push(info);
      console.log(`  MFL league ${lg.id} (${info.league_name}): ${info.teams.length} teams, draft_complete=${info.draft_complete}`);
    } catch (err) {
      console.error(`  MFL league ${lg.id} failed: ${err.message}`);
    }
    await sleep(MFL_THROTTLE_MS);
  }
  return results;
}

// ---- Sleeper -------------------------------------------------------------

async function findSleeperLeagues() {
  const seed = SLEEPER_SEED_USER_ID || SLEEPER_SEED_USERNAME;
  if (!seed) {
    throw new Error('No Sleeper seed account provided. Set SLEEPER_USER_ID or SLEEPER_USERNAME.');
  }
  const user = await getJSON(`${SLEEPER_API}/user/${encodeURIComponent(seed)}`);
  if (!user || !user.user_id) throw new Error(`Sleeper account "${seed}" not found`);

  const leagues = await getJSON(`${SLEEPER_API}/user/${user.user_id}/leagues/nfl/${YEAR}`);
  return (leagues || []).filter((lg) => (lg.name || '').toUpperCase().includes('#SFB16'));
}

async function fetchSleeperLeagueInfo(league) {
  const [users, drafts] = await Promise.all([
    getJSON(`${SLEEPER_API}/league/${league.league_id}/users`),
    getJSON(`${SLEEPER_API}/league/${league.league_id}/drafts`),
  ]);

  const usersByUserId = {};
  (users || []).forEach((u) => {
    usersByUserId[u.user_id] = {
      username: u.display_name || null,
      team_name: u.metadata?.team_name || null,
    };
  });

  // A league can technically have more than one draft object; #SFB16 leagues
  // are single-draft bestball, so use the first one returned.
  const draft = (drafts || [])[0] || null;

  const teams = Object.entries(usersByUserId).map(([userId, u]) => ({
    user_id: userId,
    username: u.username,
    team_name: u.team_name,
    draft_position: draft?.draft_order ? (draft.draft_order[userId] ?? null) : null,
  }));

  return {
    league_id: league.league_id,
    league_name: league.name || null,
    draft_id: draft?.draft_id || null,
    draft_status: draft?.status || null, // e.g. "pre_draft" | "drafting" | "complete"
    draft_complete: draft ? draft.status === 'complete' : false,
    teams,
  };
}

async function collectSleeperLeagueInfo() {
  const seedLabel = SLEEPER_SEED_USERNAME || SLEEPER_SEED_USER_ID;
  console.log(`Crawling #SFB16 leagues on Sleeper for seed account "${seedLabel}"...`);
  const leagues = await findSleeperLeagues();
  console.log(`Found ${leagues.length} Sleeper #SFB16 leagues`);

  const results = [];
  for (const lg of leagues) {
    try {
      const info = await fetchSleeperLeagueInfo(lg);
      results.push(info);
      console.log(`  Sleeper league ${lg.league_id} (${info.league_name}): ${info.teams.length} teams, draft_status=${info.draft_status}`);
    } catch (err) {
      console.error(`  Sleeper league ${lg.league_id} failed: ${err.message}`);
    }
    await sleep(SLEEPER_THROTTLE_MS);
  }
  return results;
}

// ---- main ----------------------------------------------------------------

async function main() {
  const [mflLeagues, sleeperLeagues] = await Promise.all([
    collectMflLeagueInfo(),
    collectSleeperLeagueInfo(),
  ]);

  const output = {
    generated_at: new Date().toISOString(),
    season: YEAR,
    mfl: {
      league_count: mflLeagues.length,
      leagues: mflLeagues,
    },
    sleeper: {
      league_count: sleeperLeagues.length,
      leagues: sleeperLeagues,
    },
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Wrote ${mflLeagues.length} MFL leagues and ${sleeperLeagues.length} Sleeper leagues to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
