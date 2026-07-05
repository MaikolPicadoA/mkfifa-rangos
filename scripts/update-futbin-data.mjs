import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceUrl = "https://www.futbin.com/26/latest";
const maxPages = Number(process.env.MAX_PAGES || 255);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const dataDir = path.join(rootDir, "data");
const playersPath = path.join(dataDir, "players.json");
const metadataPath = path.join(dataDir, "metadata.json");
const indexPath = path.join(rootDir, "index.html");
const appPath = path.join(rootDir, "src", "app.js");

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-blink-features=AutomationControlled"],
});

try {
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    locale: "es-ES",
  });

  const players = [];
  const seenUrls = new Set();
  const pageCounts = [];

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const pageUrl = pageNumber === 1 ? sourceUrl : `${sourceUrl}?page=${pageNumber}`;
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForSelector("tr.player-row", { timeout: 30000 });

    const pagePlayers = await page.evaluate(parsePlayersFromPage, pageNumber);
    if (!pagePlayers.length) {
      pageCounts.push({ page: pageNumber, count: 0 });
      break;
    }

    for (const player of pagePlayers) {
      if (seenUrls.has(player.url)) continue;
      seenUrls.add(player.url);
      players.push(player);
    }

    pageCounts.push({ page: pageNumber, count: pagePlayers.length });

    if (pageNumber % 25 === 0) {
      console.log(`Scraped page ${pageNumber}, players ${players.length}`);
    }
  }

  if (!players.length) {
    throw new Error("No se encontraron jugadores en FUTBIN.");
  }

  const updatedAtUtc = new Date().toISOString();
  const version = toVersion(updatedAtUtc);

  await writeFile(playersPath, `${JSON.stringify(players, null, 2)}\n`, "utf8");
  await writeFile(
    metadataPath,
    `${JSON.stringify(
      {
        updatedAtUtc,
        source: sourceUrl,
        pagesRequested: maxPages,
        pagesScraped: pageCounts.filter((item) => item.count > 0).length,
        players: players.length,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await updateCacheVersion(version);

  console.log(`Updated ${players.length} players from ${pageCounts.length} pages at ${updatedAtUtc}`);
} finally {
  await browser.close();
}

async function updateCacheVersion(version) {
  const [indexHtml, appJs] = await Promise.all([
    readFile(indexPath, "utf8"),
    readFile(appPath, "utf8"),
  ]);

  await writeFile(
    indexPath,
    indexHtml.replace(/src="src\/app\.js\?v=\d+"/, `src="src/app.js?v=${version}"`),
    "utf8",
  );

  await writeFile(
    appPath,
    appJs.replace(/const dataVersion = "\d+";/, `const dataVersion = "${version}";`),
    "utf8",
  );
}

function parsePlayersFromPage(pageNumber) {
  const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
  const parseNumber = (value) => {
    const text = String(value || "").trim().toUpperCase().replace(/,/g, "");
    const match = text.match(/(\d+(?:\.\d+)?)\s*([KM]?)/);
    if (!match) return 0;
    const multiplier = match[2] === "M" ? 1000000 : match[2] === "K" ? 1000 : 1;
    return Math.round(Number(match[1]) * multiplier);
  };
  const parseRange = (value) => {
    const matches = String(value || "").toUpperCase().match(/\d+(?:[\.,]\d+)?\s*[KM]?/g) || [];
    if (matches.length < 2) return { min: 0, max: 0 };
    return { min: parseNumber(matches[0]), max: parseNumber(matches[1]) };
  };
  const makeId = (player, index) => `${player.name}-${player.rating}-${index + 1}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  return [...document.querySelectorAll("tr.player-row")].map((row, index) => {
    const cells = [...row.querySelectorAll("td")].map((td) => clean(td.innerText));
    const href = row.querySelector('a[href*="/26/player/"]')?.getAttribute("href");
    if (cells.length < 8 || !href) return null;

    const rating = parseNumber(cells[1]);
    const name = cells[0].replace(/^\d+\s+/, "").trim();
    const positions = cells[2].split(/\s+/).filter(Boolean);
    const consolePrice = parseNumber(cells[3]);
    const pcPrice = parseNumber(cells[5]);
    const player = {
      name,
      rating,
      positions,
      positionGroup: positions.includes("GK") ? "GK" : "OUT",
      foot: "",
      skills: 0,
      weakFoot: 0,
      stats: {},
      prices: { console: consolePrice, pc: pcPrice },
      primaryPrice: { console: consolePrice, pc: pcPrice },
      priceRange: { console: parseRange(cells[4]), pc: parseRange(cells[6]) },
      addedOn: cells[7] || "",
      sourcePage: pageNumber,
      sourceIndex: index + 1,
      url: new URL(href, location.origin).href,
    };
    player.id = makeId(player, index + (pageNumber - 1) * 100);
    return player;
  }).filter(Boolean);
}

function toVersion(value) {
  return value.replace(/\D/g, "").slice(0, 14);
}
