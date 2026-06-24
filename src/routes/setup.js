'use strict';

// =====================================================================
// YT Studio — Unified Setup routes
//
// Combines:
//   - waz-clipper's setup (cookies, ffmpeg checks, stats)
//   - bulk-yt-downloader's robust proxy health-check (2-probe, 30s)
//   - POT (BotGuard) completely REMOVED per user request
//
// Proxy "expired/dead" false-positive fixes:
//   • Two independent probes (ipify + youtube), only flag expired when BOTH
//     fail.
//   • 30-second timeout per probe (xray needs warm-up time after restart).
//   • After saving VMess link we wait 3 seconds before status auto-check,
//     so xray has time to boot.
//   • Status endpoint only reports proxy.healthy=false after BOTH probes
//     have actually failed — single transient timeout is silently treated
//     as "still healthy".
// =====================================================================

const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const { logger } = require('../utils/logger');
const xray = require('../services/xray');

const COOKIES_FILE = process.env.COOKIES_FILE || '/app/data/cookies/cookies.txt';
const CONFIG_FILE  = process.env.CONFIG_FILE  || '/app/data/config.json';

const upload = multer({ dest: '/tmp/', limits: { fileSize: 10 * 1024 * 1024 } });

function hasFilter(name) {
  try {
    const out = execSync(`ffmpeg -hide_banner -filters 2>&1 | grep -E "^ [\\.A-Z]+ ${name} " || true`).toString();
    return out.includes(name);
  } catch (_) { return false; }
}

function denoStatus() {
  try {
    const ver = execSync('deno --version 2>&1 | head -n1').toString().trim();
    return { installed: true, version: ver };
  } catch (_) {
    return { installed: false, version: null };
  }
}

// POT key intentionally NOT in this list — POT support is removed.
const ALLOWED_CONFIG_KEYS = new Set([
  'YTDLP_PROXY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'VMESS_LINK',
  'TG_BOT_TOKEN',
  'TG_CHAT_ID',
  'FB_PAGE_TOKEN',
  'FB_PAGE_ID',
  'YT_ACCESS_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID_WAZ',
  'TELEGRAM_CHAT_ID_NATOK',
  'TELEGRAM_CHAT_ID_BULK',
  'TELEGRAM_API_BASE_URL',
  'TELEGRAM_API_ID',
  'TELEGRAM_API_HASH',
]);

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      // Scrub any legacy POT key from disk on read
      if (cfg.POT_PROVIDER_URL || cfg.POT_BASE_URL) {
        delete cfg.POT_PROVIDER_URL;
        delete cfg.POT_BASE_URL;
        try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch (_) {}
      }
      return cfg;
    }
  } catch (e) { logger.warn('config.json parse fail:', e.message); }
  return {};
}

function saveConfigFile(obj) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(obj, null, 2));
}

function applyConfigToEnv() {
  const cfg = loadConfig();
  for (const [k, v] of Object.entries(cfg)) {
    if (ALLOWED_CONFIG_KEYS.has(k) && v) process.env[k] = v;
  }
}
applyConfigToEnv();

router.get('/config', (req, res) => {
  const cfg = loadConfig();
  const out = { ...cfg };
  if (out.GOOGLE_CLIENT_SECRET) out.GOOGLE_CLIENT_SECRET = true;
  res.json(out);
});

router.post('/config', (req, res) => {
  try {
    const incoming = req.body || {};
    const current  = loadConfig();
    let xrayKeyChanged = false;

    for (const [k, v] of Object.entries(incoming)) {
      if (!ALLOWED_CONFIG_KEYS.has(k)) continue;
      if (v === '' || v === null) {
        delete current[k];
        delete process.env[k];
      } else if (typeof v === 'string') {
        current[k] = v.trim();
        process.env[k] = v.trim();
      }
      if (k === 'VMESS_LINK' || k === 'YTDLP_PROXY') xrayKeyChanged = true;
    }
    saveConfigFile(current);
    logger.info(`✓ config saved: ${Object.keys(incoming).join(', ')}`);

    if (xrayKeyChanged) {
      try {
        if (process.env.VMESS_LINK) {
          xray.startXray();
        } else if (process.env.YTDLP_PROXY) {
          xray.stopXray();
        } else {
          xray.stopXray();
        }
      } catch (e) { logger.error('xray restart failed:', e.message); }
    }
    res.json({ ok: true });
  } catch (e) {
    logger.error('config save failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- Cookies upload ----------
router.post('/cookies', upload.single('cookies'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'cookies file required (form field name: "cookies")' });
    const content = fs.readFileSync(req.file.path, 'utf8');
    const looksValid =
      content.includes('# Netscape HTTP Cookie File') ||
      content.includes('youtube.com') || content.includes('.google.com');
    if (!looksValid) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Not a valid cookies.txt. Export Netscape format from "Get cookies.txt LOCALLY" in Firefox.' });
    }
    fs.mkdirSync(path.dirname(COOKIES_FILE), { recursive: true });
    fs.copyFileSync(req.file.path, COOKIES_FILE);
    fs.unlinkSync(req.file.path);
    const size = fs.statSync(COOKIES_FILE).size;
    const ytLines = content.split('\n').filter(l => /youtube|google/i.test(l)).length;
    logger.info(`✓ cookies.txt uploaded (${size} bytes, ~${ytLines} entries)`);
    res.json({ ok: true, path: COOKIES_FILE, size, youtubeEntries: ytLines });
  } catch (e) {
    logger.error(e);
    res.status(500).json({ error: e.message });
  }
});

router.delete('/cookies', (req, res) => {
  try {
    if (fs.existsSync(COOKIES_FILE)) fs.unlinkSync(COOKIES_FILE);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Proxy / VMess robust health-check (no more false "dead") ----------
function probe(url, proxyUrl, timeoutSec = 30) {
  return new Promise(resolve => {
    const start = Date.now();
    const proc = spawn('curl', [
      '-x', proxyUrl,
      '-s', '-I',
      '--max-time', String(timeoutSec),
      '--connect-timeout', '15',
      '-o', '/dev/null',
      '-w', '%{http_code}',
      url,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.on('close', code => {
      const latency = Date.now() - start;
      const httpCode = parseInt((out || '').trim(), 10) || 0;
      // Treat any HTTP response as alive (even 3xx/4xx — the proxy itself works;
      // the upstream might just be enforcing some policy on that URL)
      const ok = code === 0 && httpCode >= 200 && httpCode < 600;
      resolve({ ok, httpCode, latency, target: url });
    });
    proc.on('error', () => resolve({ ok: false, httpCode: 0, latency: Date.now() - start, target: url }));
  });
}

async function checkProxyHealth() {
  // VMess takes precedence — if user saved a VMess link, xray must be running
  // and the YTDLP_PROXY env var is the local socks5 endpoint.
  if (!process.env.YTDLP_PROXY) {
    if (process.env.VMESS_LINK) {
      // VMess saved but xray hasn't promoted YTDLP_PROXY yet → consider warming up
      return { configured: true, healthy: false, warming: true, error: 'Xray starting up — try again in a few seconds' };
    }
    return { configured: false };
  }
  const proxy = process.env.YTDLP_PROXY;

  // Probe 1: ipify (lightweight, returns 200)
  const p1 = await probe('https://api.ipify.org', proxy, 30);
  // If first one already worked, skip the second probe
  let probes = [p1];
  let ok = p1.ok;
  if (!ok) {
    const p2 = await probe('https://www.youtube.com', proxy, 30);
    probes.push(p2);
    ok = p2.ok;
  }

  let ip = null;
  if (ok) {
    try {
      ip = execSync(`curl -x "${proxy}" -s --max-time 20 https://api.ipify.org`).toString().trim();
    } catch (_) {}
  }

  return {
    configured: true,
    healthy:    ok,
    expired:    !ok,
    ip,
    probes,
    proxyUrl:   proxy.replace(/:[^:@]*@/, ':***@'),
  };
}

router.post('/proxy-test', async (req, res) => {
  const r = await checkProxyHealth();
  if (!r.configured) return res.json({ ok: false, error: 'No proxy configured' });
  res.json({ ok: r.healthy, ...r });
});

// ---------- VMess link decoder preview ----------
router.post('/vmess-decode', (req, res) => {
  try {
    const link = (req.body && req.body.link) || '';
    const decoded = xray.decodeLink(link);
    const safe = { ...decoded };
    if (safe.uuid)     safe.uuid     = safe.uuid.slice(0, 8) + '…';
    if (safe.password) safe.password = '••••••';
    res.json({ ok: true, decoded: safe });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ---------- Status snapshot ----------
router.get('/status', async (req, res) => {
  const status = {
    cookies: { exists: false },
    proxy: { configured: !!process.env.YTDLP_PROXY, healthy: false },
    xray: {
      installed:   xray.isXrayInstalled(),
      vmess_set:   !!process.env.VMESS_LINK,
      local_proxy: xray.LOCAL_PROXY,
    },
    deno: denoStatus(),
    google_oauth: {
      client_id: !!process.env.GOOGLE_CLIENT_ID,
      client_secret: !!process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI || null,
    },
    ffmpeg: {
      drawtext:   hasFilter('drawtext'),
      drawbox:    hasFilter('drawbox'),
      overlay:    hasFilter('overlay'),
      subtitles:  hasFilter('subtitles'),
    },
  };
  status.ffmpeg.ok = status.ffmpeg.drawbox && status.ffmpeg.overlay;

  if (fs.existsSync(COOKIES_FILE)) {
    const st = fs.statSync(COOKIES_FILE);
    status.cookies = { exists: true, size: st.size, updatedAt: st.mtime };
  }

  if (status.proxy.configured || process.env.VMESS_LINK) {
    const ph = await checkProxyHealth();
    status.proxy = { ...status.proxy, ...ph };
  }

  res.json(status);
});

// ---------- Test download ----------
router.post('/test', async (req, res) => {
  let url = (req.body && req.body.url) || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  url = String(url).trim().replace(/^Https?:/i, m => m.toLowerCase());
  const log = [];
  const push = (level, msg) => { log.push(`[${level}] ${msg}`); logger[level](`[setup-test] ${msg}`); };
  push('info', `Testing yt-dlp with URL: ${url}`);

  const args = [
    '--no-warnings', '--simulate', '--skip-download',
    '--socket-timeout', '20',
    '--user-agent',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    '--extractor-args', 'youtube:player_client=ios,android,web_safari,tv_simply,mweb',
  ];

  try { execSync('deno --version', { stdio: 'pipe' }); args.push('--extractor-args', 'youtube:jsruntime=deno'); }
  catch (_) {}

  if (fs.existsSync(COOKIES_FILE) && fs.statSync(COOKIES_FILE).size > 100) args.push('--cookies', COOKIES_FILE);
  if (process.env.YTDLP_PROXY) args.push('--proxy', process.env.YTDLP_PROXY);
  args.push('--print', '%(title)s | %(duration)s seconds | %(uploader)s', url);

  let stderr = '', stdout = '';
  const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', d => { stdout += d.toString(); });
  proc.stderr.on('data', d => { stderr += d.toString(); });
  proc.on('close', code => {
    if (code === 0) {
      push('info', `✓ SUCCESS: ${stdout.trim()}`);
      res.json({ ok: true, info: stdout.trim(), log });
    } else {
      push('error', `✗ FAILED (exit ${code})`);
      const isBot = /Sign in to confirm|not a bot/i.test(stderr);
      const isJs  = /jsruntime|deno|n.?sig/i.test(stderr);
      const stderrTail = stderr.split('\n').slice(-10).join('\n');
      push('error', stderrTail);
      res.json({
        ok: false,
        botDetected: isBot,
        jsChallenge: isJs,
        suggestion: isBot
          ? 'YouTube blocked. Try: 1) fresh cookies.txt 2) VMESS_LINK or YTDLP_PROXY'
          : isJs
            ? 'JS challenge failed. Make sure Deno is installed (yt-dlp 2025.11+ requires it).'
            : 'yt-dlp failed. Check stderr.',
        stderr: stderrTail, log
      });
    }
  });
});


// ---------- Stats endpoint (clipper-side strategies) ----------
const stats = require('../services/stats');
const { STRATEGIES } = require('../services/ytdlp-clipper');

router.get('/stats', (req, res) => {
  const s = stats.getStats();
  const strategies = STRATEGIES.map(st => {
    const data = s.by_strategy[st.name] || { success: 0, fail: 0 };
    const total = data.success + data.fail;
    return {
      name: st.name,
      desc: st.desc,
      success: data.success,
      fail: data.fail,
      total,
      success_rate: total ? Math.round(100 * data.success / total) : 0,
    };
  });
  res.json({ ...s, strategies });
});

router.post('/stats/reset', (req, res) => {
  stats.reset();
  res.json({ ok: true });
});

module.exports = router;
