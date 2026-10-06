const fs = require("fs");
const path = require("path");

const TELEMETRY_CACHE_DIR = path.join(__dirname, "cache", "telemetry");
const LOGO_CACHE_DIR = path.join(__dirname, "cache", "logos");
const MAPS_DIR = path.join(__dirname, "assets", "maps");
const OUTPUT_DIR = path.join(__dirname, "output");

// Telemetry mapName -> background image + playable map size in game units
// (the standard sizes used throughout the PUBG analytics community; actual
// in-match coordinates can slightly exceed this near coastlines/out-of-bounds).
const MAPS = {
  Baltic_Main: { image: "Baltic_Main.png", size: 816000, friendlyName: "Erangel" },
  Desert_Main: { image: "Desert_Main.png", size: 816000, friendlyName: "Miramar" },
  Tiger_Main: { image: "Tiger_Main.png", size: 816000, friendlyName: "Taego" },
  DihorOtok_Main: { image: "DihorOtok_Main.png", size: 816000, friendlyName: "Vikendi" },
};

const MATCHES_URL =
  "https://haukkastats.com/tournaments/pappaliiga-s12-syksy-2026-2/matches?division=5-divisioona";
const STANDINGS_URL =
  "https://haukkastats.com/tournaments/pappaliiga-s12-syksy-2026-2?view=standings&division=5-divisioona";

// A generic "Mozilla/5.0" User-Agent (no browser/OS details) can get flagged
// as a bot by Cloudflare, so send a full, realistic header set instead.
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://haukkastats.com/",
};

async function fetchHtml(url) {
  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status}`);
  }
  return res.text();
}

async function getMatches(url) {
  const html = await fetchHtml(url);

  // Match links are rendered as /tournaments/<tournamentId>/matches/<uuid>
  const linkPattern = /\/tournaments\/([a-z0-9]+)\/matches\/([a-f0-9-]{36})/g;
  const matches = new Map();
  for (const match of html.matchAll(linkPattern)) {
    matches.set(match[2], { tournamentId: match[1], matchId: match[2] });
  }
  return [...matches.values()];
}

// Next.js streams the page's data as JSON inside self.__next_f.push([1, "..."])
// script calls; the standings table (with nested per-team playerStats) lives
// in one of those chunks rather than in the static markup.
function findMatchingBracket(str, openIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openIndex; i < str.length; i++) {
    const ch = str[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error("Unbalanced brackets while scanning for standings array");
}

function getStandingsRows(html) {
  const pushPattern = /self\.__next_f\.push\(\[1,"(.*?)"\]\)/gs;
  for (const match of html.matchAll(pushPattern)) {
    const chunk = JSON.parse(`"${match[1]}"`);
    const key = '"standings":[';
    const keyIndex = chunk.indexOf(key);
    if (keyIndex === -1) continue;

    const arrayStart = keyIndex + key.length - 1; // position of the "["
    const arrayEnd = findMatchingBracket(chunk, arrayStart);
    return JSON.parse(chunk.slice(arrayStart, arrayEnd + 1));
  }
  throw new Error("Could not find standings data in page");
}

async function getTeams(url, divisionName) {
  const html = await fetchHtml(url);
  const rows = getStandingsRows(html);

  const teams = {};
  for (const row of rows) {
    if (row.divisionName !== divisionName) continue;
    teams[row.teamName] = {
      logoUrl: row.logoUrl,
      players: (row.playerStats ?? []).map((p) => p.playerName),
    };
  }
  return teams;
}

// Downloads each team's logo once and caches it on disk by the filename in
// its logoUrl, so later runs (and the generated pages) don't depend on
// assets.haukkastats.com staying up.
async function cacheTeamLogos(teams) {
  fs.mkdirSync(LOGO_CACHE_DIR, { recursive: true });

  const logoFileByTeam = {};
  for (const [teamName, { logoUrl }] of Object.entries(teams)) {
    const fileName = path.basename(new URL(logoUrl).pathname);
    const cachePath = path.join(LOGO_CACHE_DIR, fileName);

    if (!fs.existsSync(cachePath)) {
      const res = await fetch(logoUrl, { headers: BROWSER_HEADERS });
      if (!res.ok) {
        throw new Error(`Failed to fetch logo for ${teamName}: ${res.status}`);
      }
      fs.writeFileSync(cachePath, Buffer.from(await res.arrayBuffer()));
    }

    logoFileByTeam[teamName] = fileName;
  }
  return logoFileByTeam;
}

function telemetryUrl(tournamentId, matchId) {
  return `https://match.haukkastats.com/telemetry/${tournamentId}/${matchId}.json.gz`;
}

async function getTelemetry(tournamentId, matchId) {
  const cachePath = path.join(TELEMETRY_CACHE_DIR, `${matchId}.json`);
  if (fs.existsSync(cachePath)) {
    return JSON.parse(fs.readFileSync(cachePath, "utf8"));
  }

  // Despite the .json.gz name, the server responds with plain JSON (no
  // content-encoding), so a normal fetch + .json() is enough.
  const res = await fetch(telemetryUrl(tournamentId, matchId), {
    headers: BROWSER_HEADERS,
  });
  if (!res.ok) {
    throw new Error(
      `Failed to fetch telemetry for ${matchId}: ${res.status}`
    );
  }
  const text = await res.text();

  fs.mkdirSync(TELEMETRY_CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath, text);

  return JSON.parse(text);
}

// Builds a lookup from player name -> real team name, so in-game squads
// (which only carry a numeric teamId) can be resolved back to the teams
// scraped from the standings page.
function buildPlayerToTeam(teams) {
  const playerToTeam = {};
  for (const [teamName, { players }] of Object.entries(teams)) {
    for (const player of players) {
      playerToTeam[player] = teamName;
    }
  }
  return playerToTeam;
}

function getLandings(telemetry, playerToTeam) {
  // Some custom matches let eliminated players redeploy by parachute later
  // on, which re-fires LogParachuteLanding. Telemetry events are strictly
  // chronological, so keeping only the first one per player gives the
  // initial drop from the plane rather than a mid-match redeploy.
  const seenPlayers = new Set();
  const landings = {};
  for (const event of telemetry) {
    if (event._T !== "LogParachuteLanding") continue;
    const { name, location } = event.character;
    if (seenPlayers.has(name)) continue;
    seenPlayers.add(name);

    const teamName = playerToTeam[name] ?? `unknown (in-game team ${event.character.teamId})`;
    (landings[teamName] ??= []).push({
      player: name,
      x: location.x,
      y: location.y,
    });
  }
  return landings;
}

function averageLandings(landings) {
  const averages = {};
  for (const [teamName, players] of Object.entries(landings)) {
    averages[teamName] = {
      x: players.reduce((sum, p) => sum + p.x, 0) / players.length,
      y: players.reduce((sum, p) => sum + p.y, 0) / players.length,
    };
  }
  return averages;
}

function getMatchStart(telemetry) {
  return telemetry.find((e) => e._T === "LogMatchStart");
}

async function getAllLandings(matches, teams) {
  const playerToTeam = buildPlayerToTeam(teams);
  const landingsByMatch = {};
  for (const { tournamentId, matchId } of matches) {
    const telemetry = await getTelemetry(tournamentId, matchId);
    const matchStart = getMatchStart(telemetry);
    landingsByMatch[matchId] = {
      mapName: matchStart?.mapName,
      startedAt: matchStart?._D,
      landings: getLandings(telemetry, playerToTeam),
    };
  }
  return landingsByMatch;
}

// One color per match on a given map, so overlapping teams across matches
// stay distinguishable.
const MATCH_COLORS = [
  "#e6194b",
  "#3cb44b",
  "#4363d8",
  "#f58231",
  "#911eb4",
  "#42d4f4",
  "#f032e6",
  "#bfef45",
];

function formatMatchDate(startedAt) {
  return new Date(startedAt).toLocaleString("fi-FI", {
    timeZone: "Europe/Helsinki",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function renderMapHtml(mapName, matchesOnMap, logoFileByTeam, allMapNames) {
  const map = MAPS[mapName];
  if (!map) {
    throw new Error(`No map asset configured for mapName "${mapName}"`);
  }

  const nav = allMapNames
    .map((name) =>
      name === mapName
        ? `<span class="nav-item current">${MAPS[name].friendlyName}</span>`
        : `<a class="nav-item" href="${MAPS[name].friendlyName}.html">${MAPS[name].friendlyName}</a>`
    )
    .join("");

  const legend = matchesOnMap
    .map(
      ({ startedAt }, i) => `
      <div class="legend-item" data-match="${i}" onclick="toggleMatch(${i})">
        <span class="swatch" style="background: ${MATCH_COLORS[i % MATCH_COLORS.length]};"></span>
        ${formatMatchDate(startedAt)}
      </div>`
    )
    .join("");

  const markerLayers = matchesOnMap
    .map(({ startedAt, averages }, i) => {
      const color = MATCH_COLORS[i % MATCH_COLORS.length];
      const matchLabel = formatMatchDate(startedAt);
      const markers = Object.entries(averages)
        .map(([teamName, { x, y }]) => {
          const left = (x / map.size) * 100;
          const top = (y / map.size) * 100;
          const logoFile = logoFileByTeam[teamName] ?? "";
          return `
      <div class="marker" style="left: ${left}%; top: ${top}%;" title="${teamName} — ${matchLabel}">
        <img src="assets/logos/${logoFile}" alt="${teamName}" style="border-color: ${color};" />
        <span>${teamName}</span>
      </div>`;
        })
        .join("");
      return `<div class="match-layer" data-match="${i}">${markers}</div>`;
    })
    .join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${map.friendlyName}</title>
<style>
  body { margin: 0; background: #111; font-family: sans-serif; }
  .nav {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    padding: 12px 12px 0;
  }
  .nav-item {
    color: #9ab;
    text-decoration: none;
    font-size: 13px;
  }
  .nav-item:hover { text-decoration: underline; }
  .nav-item.current { color: white; font-weight: bold; }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 16px;
    padding: 8px 12px;
    color: white;
    font-size: 12px;
  }
  .legend-item {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    user-select: none;
  }
  .legend-item.off { opacity: 0.35; }
  .swatch {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    display: inline-block;
  }
  .match-layer.hidden { display: none; }
  .map {
    position: relative;
    width: 1200px;
    aspect-ratio: 1 / 1;
    margin: 0 auto;
    background-image: url("assets/maps/${map.image}");
    background-size: cover;
  }
  .marker {
    position: absolute;
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .marker img {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: 3px solid white;
    box-shadow: 0 0 4px black;
  }
  .marker span {
    margin-top: 2px;
    padding: 1px 4px;
    font-size: 11px;
    color: white;
    background: rgba(0, 0, 0, 0.6);
    border-radius: 3px;
    white-space: nowrap;
  }
</style>
</head>
<body>
  <div class="nav">${nav}</div>
  <div class="legend">${legend}</div>
  <div class="map">${markerLayers}</div>
  <script>
    function toggleMatch(i) {
      document
        .querySelector('.match-layer[data-match="' + i + '"]')
        .classList.toggle("hidden");
      document
        .querySelector('.legend-item[data-match="' + i + '"]')
        .classList.toggle("off");
    }
  </script>
</body>
</html>`;
}

function groupByMap(landingsByMatch) {
  const matchesByMap = {};
  for (const [matchId, { mapName, startedAt, landings }] of Object.entries(
    landingsByMatch
  )) {
    (matchesByMap[mapName] ??= []).push({
      matchId,
      startedAt,
      averages: averageLandings(landings),
    });
  }
  for (const matchesOnMap of Object.values(matchesByMap)) {
    matchesOnMap.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }
  return matchesByMap;
}

function copyMapAssets(mapNames) {
  const destDir = path.join(OUTPUT_DIR, "assets", "maps");
  fs.mkdirSync(destDir, { recursive: true });
  for (const mapName of mapNames) {
    const { image } = MAPS[mapName];
    fs.copyFileSync(path.join(MAPS_DIR, image), path.join(destDir, image));
  }
}

function copyLogoAssets(logoFileByTeam) {
  const destDir = path.join(OUTPUT_DIR, "assets", "logos");
  fs.mkdirSync(destDir, { recursive: true });
  for (const fileName of new Set(Object.values(logoFileByTeam))) {
    fs.copyFileSync(
      path.join(LOGO_CACHE_DIR, fileName),
      path.join(destDir, fileName)
    );
  }
}

async function writeMapPages(landingsByMatch, logoFileByTeam) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const matchesByMap = groupByMap(landingsByMatch);
  const allMapNames = Object.keys(matchesByMap);
  copyMapAssets(allMapNames);
  copyLogoAssets(logoFileByTeam);
  for (const [mapName, matchesOnMap] of Object.entries(matchesByMap)) {
    const html = renderMapHtml(mapName, matchesOnMap, logoFileByTeam, allMapNames);
    const fileName = `${MAPS[mapName].friendlyName}.html`;
    fs.writeFileSync(path.join(OUTPUT_DIR, fileName), html);
  }

  const firstPage = `${MAPS[allMapNames[0]].friendlyName}.html`;
  fs.writeFileSync(
    path.join(OUTPUT_DIR, "index.html"),
    `<!doctype html><meta http-equiv="refresh" content="0; url=${firstPage}">`
  );
}

async function main() {
  const matches = await getMatches(MATCHES_URL);
  const teams = await getTeams(STANDINGS_URL, "5. Divisioona");

  const landingsByMatch = await getAllLandings(matches, teams);
  const logoFileByTeam = await cacheTeamLogos(teams);
  await writeMapPages(landingsByMatch, logoFileByTeam);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
