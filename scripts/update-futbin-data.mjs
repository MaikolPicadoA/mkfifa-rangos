import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceUrl = "https://www.futbin.com/26/latest";
const maxPages = Number(process.env.MAX_PAGES || 255);
const maxAttempts = Number(process.env.PAGE_RETRIES || 5);
const retryBaseMs = Number(process.env.RETRY_BASE_MS || 12000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const dataDir = path.join(rootDir, "data");
const artifactsDir = path.join(rootDir, "artifacts");
const playersPath = path.join(dataDir, "players.json");
const metadataPath = path.join(dataDir, "metadata.json");
const indexPath = path.join(rootDir, "index.html");
const appPath = path.join(rootDir, "src", "app.js");

const browser = await chromium.launch({
  headless: true,
  args: [
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage",
    "--no-sandbox",
  ],
});

try {
  await mkdir(artifactsDir, { recursive: true });
  let page = await createPage();

  const players = [];
  const seenUrls = new Set();
  const pageCounts = [];

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const result = await scrapePageWithRetries(page, pageNumber);
    page = result.page;
    const pagePlayers = result.players;
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

async function createPage() {
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    locale: "es-ES",
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: {
      "accept-language": "es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });
  page.setDefaultTimeout(60000);
  return page;
}

async function scrapePageWithRetries(page, pageNumber) {
  let activePage = page;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const pageUrl = pageNumber === 1 ? sourceUrl : `${sourceUrl}?page=${pageNumber}`;

    try {
      console.log(`Loading page ${pageNumber}/${maxPages}, attempt ${attempt}/${maxAttempts}`);
      await activePage.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
      await activePage.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      await activePage.waitForFunction(
        () => document.querySelectorAll("tr.player-row").length > 0,
        undefined,
        { timeout: 75000 },
      );

      const pagePlayers = await activePage.evaluate(parsePlayersFromPage, pageNumber);
      if (pagePlayers.length > 0) {
        return { page: activePage, players: pagePlayers };
      }

      throw new Error("La tabla cargo, pero no devolvio jugadores.");
    } catch (error) {
      lastError = error;
      const diagnostic = await getPageDiagnostic(activePage).catch((diagError) => ({
        title: "diagnostic failed",
        url: pageUrl,
        snippet: diagError.message,
        blocked: false,
      }));
      console.warn(
        [
          `Page ${pageNumber} attempt ${attempt} failed: ${error.message}`,
          `Title: ${diagnostic.title}`,
          `URL: ${diagnostic.url}`,
          `Blocked: ${diagnostic.blocked ? "yes" : "no"}`,
          `Snippet: ${diagnostic.snippet}`,
        ].join("\n"),
      );

      await saveFailureScreenshot(activePage, pageNumber, attempt).catch(() => {});
      if (attempt === maxAttempts) break;

      const waitMs = retryBaseMs * attempt + Math.floor(Math.random() * 4000);
      await activePage.waitForTimeout(waitMs).catch(() => {});

      if (attempt % 2 === 0 || diagnostic.blocked) {
        await activePage.close().catch(() => {});
        activePage = await createPage();
      }
    }
  }

  throw new Error(
    `No se pudo leer FUTBIN page=${pageNumber} despues de ${maxAttempts} intentos. ` +
      `No se publica data parcial. Ultimo error: ${lastError?.message || "desconocido"}`,
  );
}

async function getPageDiagnostic(page) {
  return page.evaluate(() => {
    const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    const blocked = /just a moment|checking your browser|captcha|cloudflare|access denied|enable javascript|rate limit/i.test(text);
    return {
      title: document.title,
      url: location.href,
      snippet: text.slice(0, 500),
      blocked,
    };
  });
}

async function saveFailureScreenshot(page, pageNumber, attempt) {
  const file = path.join(artifactsDir, `futbin-page-${pageNumber}-attempt-${attempt}.png`);
  await page.screenshot({ path: file, fullPage: true, timeout: 15000 });
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
