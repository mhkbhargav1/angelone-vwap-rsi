// One shared load of Angel One's instrument master (large JSON). Concurrent callers share the request; the parsed
// array is dropped after a short TTL so ~30 MB doesn't stay in memory.
// Sources, in order: a local file (SCRIP_MASTER_FILE), then each URL (SCRIP_MASTER_URL first, then built-in fallbacks).
const fs = require('fs');
let memo = null, timer = null;

async function fetchFirst(urls, fetchImpl) {
  const tried = [];
  for (const url of urls) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) { tried.push(`${url} (HTTP ${res.status})`); continue; }
      const data = await res.json();
      if (!Array.isArray(data)) { tried.push(`${url} (unexpected format)`); continue; }
      return data;
    } catch (e) { tried.push(`${url} (${e.message})`); }
  }
  throw new Error(`Scrip master download failed. Tried: ${tried.join('; ')}. Download the file in a browser and set SCRIP_MASTER_FILE=<path> in backend/.env`);
}

function download(urls, fetchImpl = fetch, file = null) {
  if (!memo) {
    memo = (async () => {
      if (file) { try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(d)) return d; } catch (e) { throw new Error(`SCRIP_MASTER_FILE could not be read: ${e.message}`); } }
      return fetchFirst([].concat(urls).filter(Boolean), fetchImpl);
    })();
    memo.catch(() => { memo = null; });
    clearTimeout(timer); timer = setTimeout(() => { memo = null; }, 120_000); timer.unref?.();
  }
  return memo;
}
download.reset = () => { memo = null; clearTimeout(timer); };
module.exports = { download };
