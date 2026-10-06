const MATCHES_URL =
  "https://haukkastats.com/tournaments/pappaliiga-s12-syksy-2026-2/matches?division=5-divisioona";
const STANDINGS_URL =
  "https://haukkastats.com/tournaments/pappaliiga-s12-syksy-2026-2?view=standings&division=5-divisioona";
const DIVISION_NAME = "5. Divisioona";

// Telemetry mapName -> background image + playable map size in game units
// (the standard sizes used throughout the PUBG analytics community; actual
// in-match coordinates can slightly exceed this near coastlines/out-of-bounds).
const MAPS = {
  Baltic_Main: { image: "Baltic_Main.png", size: 816000, friendlyName: "Erangel" },
  Desert_Main: { image: "Desert_Main.png", size: 816000, friendlyName: "Miramar" },
  Tiger_Main: { image: "Tiger_Main.png", size: 816000, friendlyName: "Taego" },
  DihorOtok_Main: { image: "DihorOtok_Main.png", size: 816000, friendlyName: "Vikendi" },
};

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

// haukkastats.com sends no CORS headers (and its telemetry host 403s CORS
// preflights outright), so a page hosted elsewhere can't read its responses
// directly. Routing through this Worker — which adds
// Access-Control-Allow-Origin itself — solves that, and also sidesteps
// Cloudflare's IP-reputation block on datacenter traffic, since the browser
// making the request carries a real visitor IP through the proxy.
const PROXY_URL = "https://kanaliiga-proxy.aleksi-918.workers.dev";

function proxied(url) {
  return `${PROXY_URL}?url=${encodeURIComponent(url)}`;
}

async function fetchHtml(url) {
  const res = await fetch(proxied(url));
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status}`);
  }
  return res.text();
}

// Next.js can split a single list entry's JSON across multiple
// self.__next_f.push(...) chunks, so chunks must be concatenated before
// searching rather than searched one at a time.
function decodeNextChunks(html) {
  const pushPattern = /self\.__next_f\.push\(\[1,"(.*?)"\]\)/gs;
  let decoded = "";
  for (const match of html.matchAll(pushPattern)) {
    decoded += JSON.parse(`"${match[1]}"`);
  }
  return decoded;
}

async function getMatches(url) {
  const html = await fetchHtml(url);
  const decoded = decodeNextChunks(html);

  // Each match's href is followed, within the same list entry, by a span
  // with the map's friendly display name (e.g. "Erangel") — reading it here
  // means a page only has to download telemetry for matches on its own map.
  const friendlyNames = Object.values(MAPS)
    .map((m) => m.friendlyName)
    .join("|");
  const pattern = new RegExp(
    `"href":"/tournaments/([a-z0-9]+)/matches/([a-f0-9-]{36})"[\\s\\S]{0,600}?"children":"(${friendlyNames})"`,
    "g"
  );
  const matches = new Map();
  for (const m of decoded.matchAll(pattern)) {
    matches.set(m[2], { tournamentId: m[1], matchId: m[2], mapFriendlyName: m[3] });
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

function telemetryUrl(tournamentId, matchId) {
  return `https://match.haukkastats.com/telemetry/${tournamentId}/${matchId}.json.gz`;
}

async function getTelemetry(tournamentId, matchId) {
  // Despite the .json.gz name, the server responds with plain JSON (no
  // content-encoding), so a normal fetch + .json() is enough.
  const res = await fetch(proxied(telemetryUrl(tournamentId, matchId)));
  if (!res.ok) {
    throw new Error(`Failed to fetch telemetry for ${matchId}: ${res.status}`);
  }
  return res.json();
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

    const teamName =
      playerToTeam[name] ?? `unknown (in-game team ${event.character.teamId})`;
    (landings[teamName] ??= []).push({ player: name, x: location.x, y: location.y });
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

// Finished matches' computed landings never change, so cache them in
// localStorage — repeat visits skip the telemetry download and
// recomputation entirely instead of just relying on HTTP caching.
const LANDINGS_CACHE_VERSION = "v1";

function landingsCacheKey(matchId) {
  return `landing-spots:${LANDINGS_CACHE_VERSION}:${matchId}`;
}

function getCachedLandings(matchId) {
  const raw = localStorage.getItem(landingsCacheKey(matchId));
  return raw ? JSON.parse(raw) : null;
}

function setCachedLandings(matchId, data) {
  try {
    localStorage.setItem(landingsCacheKey(matchId), JSON.stringify(data));
  } catch (err) {
    // Storage full or disabled (e.g. private browsing) — not fatal, just
    // means this match gets re-fetched next time.
  }
}

async function getMatchLandings(tournamentId, matchId, playerToTeam) {
  const cached = getCachedLandings(matchId);
  if (cached) return cached;

  const telemetry = await getTelemetry(tournamentId, matchId);
  const matchStart = getMatchStart(telemetry);
  const result = {
    startedAt: matchStart?._D,
    averages: averageLandings(getLandings(telemetry, playerToTeam)),
  };
  setCachedLandings(matchId, result);
  return result;
}

function formatMatchDate(startedAt) {
  return new Date(startedAt).toLocaleString("fi-FI", {
    timeZone: "Europe/Helsinki",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function renderNav(currentMapName) {
  const nav = document.getElementById("nav");
  nav.innerHTML = Object.entries(MAPS)
    .map(([name, map]) =>
      name === currentMapName
        ? `<span class="nav-item current">${map.friendlyName}</span>`
        : `<a class="nav-item" href="${map.friendlyName}.html">${map.friendlyName}</a>`
    )
    .join("");
}

function renderStatus(message) {
  document.getElementById("status").textContent = message;
}

function renderMatches(matchesOnMap, teams) {
  document.getElementById("status").remove();

  const legend = document.getElementById("legend");
  legend.innerHTML = matchesOnMap
    .map(
      ({ startedAt }, i) => `
      <div class="legend-item" data-match="${i}" onclick="toggleMatch(${i})">
        <span class="swatch" style="background: ${MATCH_COLORS[i % MATCH_COLORS.length]};"></span>
        ${formatMatchDate(startedAt)}
      </div>`
    )
    .join("");

  const map = document.getElementById("map");
  map.innerHTML = matchesOnMap
    .map(({ startedAt, averages }, i) => {
      const color = MATCH_COLORS[i % MATCH_COLORS.length];
      const matchLabel = formatMatchDate(startedAt);
      const markers = Object.entries(averages)
        .map(([teamName, { x, y }]) => {
          const left = (x / MAPS[currentMapName].size) * 100;
          const top = (y / MAPS[currentMapName].size) * 100;
          const logoUrl = teams[teamName]?.logoUrl ?? "";
          return `
      <div class="marker" style="left: ${left}%; top: ${top}%;" title="${teamName} — ${matchLabel}">
        <img src="${logoUrl}" alt="${teamName}" style="border-color: ${color};" />
        <span>${teamName}</span>
      </div>`;
        })
        .join("");
      return `<div class="match-layer" data-match="${i}">${markers}</div>`;
    })
    .join("");
}

function toggleMatch(i) {
  document.querySelector(`.match-layer[data-match="${i}"]`).classList.toggle("hidden");
  document.querySelector(`.legend-item[data-match="${i}"]`).classList.toggle("off");
}

let currentMapName;

async function renderMap(mapName) {
  currentMapName = mapName;
  renderNav(mapName);
  document.getElementById("map").style.backgroundImage =
    `url("assets/maps/${MAPS[mapName].image}")`;

  try {
    renderStatus("Loading matches…");
    const allMatches = await getMatches(MATCHES_URL);
    const matches = allMatches.filter(
      (m) => m.mapFriendlyName === MAPS[mapName].friendlyName
    );

    renderStatus("Loading teams…");
    const teams = await getTeams(STANDINGS_URL, DIVISION_NAME);
    const playerToTeam = buildPlayerToTeam(teams);

    renderStatus(`Loading telemetry for ${matches.length} matches…`);
    const matchesOnMap = (
      await Promise.all(
        matches.map(async ({ tournamentId, matchId }) => ({
          matchId,
          ...(await getMatchLandings(tournamentId, matchId, playerToTeam)),
        }))
      )
    ).sort((a, b) => a.startedAt.localeCompare(b.startedAt));

    renderMatches(matchesOnMap, teams);
  } catch (err) {
    renderStatus(`Failed to load: ${err.message}`);
    throw err;
  }
}
