#!/usr/bin/env node
// Fetches all #SFB16 drafts on MFL server-side (this runs in GitHub Actions,
// not a browser, so MFL's CORS restriction — which only allows requests
// originating from myfantasyleague.com — doesn't apply here) and writes
// data/mfl_picks.json for the static site to fetch like any other data file.

const YEAR = 2026;
const BASE = `https://api.myfantasyleague.com/${YEAR}/export`;
const VALID_POS = ['QB', 'RB', 'WR', 'TE', 'K'];
const THROTTLE_MS = 250;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function toArray(x) { return x == null ? [] : (Array.isArray(x) ? x : [x]); }

// MFL player names are stored "Last, First" — convert to "First Last" to
// match the naming convention used everywhere else in this project (Sleeper,
// nflverse, FantasyPros).
function mflNameToFull(mflName) {
  const parts = (mflName || '').split(',');
  if (parts.length === 2) return `${parts[1].trim()} ${parts[0].trim()}`;
  return (mflName || '').trim();
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'SFB16-ADP-Bot/1.0' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function main() {
  console.log('Searching MFL for #SFB16 leagues...');
  const searchData = await fetchJson(`${BASE}?TYPE=leagueSearch&SEARCH=SFB16&JSON=1`);
  const leagues = toArray(searchData?.leagues?.league).filter(lg =>
    lg && lg.id && lg.name && /sfb16/i.test(lg.name) &&
    (lg.year === undefined || String(lg.year) === String(YEAR))
  );
  console.log(`Found ${leagues.length} MFL #SFB16 leagues`);

  console.log('Fetching MFL player directory...');
  const playersData = await fetchJson(`${BASE}?TYPE=players&JSON=1`);
  const playerList = toArray(playersData?.players?.player);
  const playersById = {};
  playerList.forEach(p => {
    playersById[p.id] = {
      name: mflNameToFull(p.name),
      pos: p.position || '',
      team: p.team || '—',
    };
  });
  console.log(`Loaded ${playerList.length} MFL players`);

  const picks = [];
  for (const lg of leagues) {
    try {
      const data = await fetchJson(`${BASE}?TYPE=draftResults&L=${lg.id}&JSON=1`);
      const units = toArray(data?.draftResults?.draftUnit);
      units.forEach(u => {
        const draftPicks = toArray(u.draftPick);
        // MFL gives round + pick-within-round, not an overall pick number.
        // Every draft round has exactly one pick per team, so the round-1
        // pick count (or distinct-franchise count as a fallback) gives us
        // the team count needed to compute the overall pick.
        const teamsCount =
          draftPicks.filter(p => parseInt(p.round, 10) === 1).length ||
          new Set(draftPicks.map(p => p.franchise)).size || 1;
        draftPicks.forEach(p => {
          const round = parseInt(p.round, 10);
          const pickInRound = parseInt(p.pick, 10);
          if (!p.player || isNaN(round) || isNaN(pickInRound)) return;
          const player = playersById[String(p.player)];
          if (!player || !player.name || !VALID_POS.includes(player.pos)) return;
          picks.push({
            name: player.name,
            pos: player.pos,
            team: player.team,
            pick_no: (round - 1) * teamsCount + pickInRound,
            league_id: lg.id,
          });
        });
      });
      console.log(`  league ${lg.id} (${lg.name}): ${picks.length} cumulative picks`);
    } catch (err) {
      console.error(`  league ${lg.id} failed: ${err.message}`);
    }
    await sleep(THROTTLE_MS);
  }

  const output = {
    generated_at: new Date().toISOString(),
    leagues: leagues.map(lg => ({ id: lg.id, name: lg.name })),
    picks,
  };

  const fs = require('fs');
  const path = require('path');
  const outPath = path.join(__dirname, '..', 'data', 'mfl_picks.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${picks.length} picks from ${leagues.length} leagues to ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
