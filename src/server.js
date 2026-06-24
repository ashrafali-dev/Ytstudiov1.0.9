'use strict';

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// Apply persistent config to process.env BEFORE loading routes that read env
const CONFIG_FILE = process.env.CONFIG_FILE || '/app/data/config.json';
try {
  if (fs.existsSync(CONFIG_FILE)) {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    // Strip legacy POT keys at boot — they have no effect anymore
    delete cfg.POT_PROVIDER_URL;
    delete cfg.POT_BASE_URL;
    for (const [k, v] of Object.entries(cfg)) {
      if (v && typeof v === 'string') process.env[k] = v;
    }
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch (_) {}
    console.log(`[boot] applied ${Object.keys(cfg).length} config keys from ${CONFIG_FILE}`);
  }
} catch (e) { console.warn('[boot] config load failed:', e.message); }

const authRoutes           = require('./routes/auth');
const jobsClipperRoutes    = require('./routes/jobs-clipper');
const jobsNatokRoutes      = require('./routes/jobs-natok');
const jobsBulkRoutes       = require('./routes/jobs-bulk');
const jobsSubburnerRoutes  = require('./routes/jobs-subburner');
const driveRoutes          = require('./routes/drive');
const telegramRoutes       = require('./routes/telegram');
const setupRoutes          = require('./routes/setup');
const xray              = require('./services/xray');
const { logger }        = require('./utils/logger');

const APP_VERSION = '1.0.0';
const BUILD_TAG   = 'yt-studio-v1.0-clipper+bulk-noPOT';

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR    = process.env.OUTPUT_DIR  || '/app/data/output';
const TEMP_DIR    = process.env.TEMP_DIR    || '/tmp/waz';
const COOKIES_DIR = path.dirname(process.env.COOKIES_FILE || '/app/data/cookies/cookies.txt');
[DATA_DIR, TEMP_DIR, COOKIES_DIR, path.dirname(CONFIG_FILE)].forEach(d => {
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
});

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 30,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production'
  }
}));
app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, 'public')));

function hasFilter(name) {
  try {
    const out = execSync(`ffmpeg -hide_banner -filters 2>&1 | grep -E "^ [\\.A-Z]+ ${name} " || true`).toString();
    return out.includes(name);
  } catch (_) { return false; }
}

function checkPillowRaqm() {
  try {
    const r = execSync(`python3 -c "from PIL import features; print(features.check('raqm'))" 2>&1`).toString().trim();
    return r === 'True';
  } catch (_) { return false; }
}

app.get('/health', (req, res) => res.json({ ok: true, version: APP_VERSION, ts: Date.now() }));

app.get('/version', (req, res) => {
  let ffmpegVersion = 'unknown', ytdlpVersion = 'unknown', denoVersion = 'unknown', xrayVersion = 'not installed';
  try { ffmpegVersion = execSync('ffmpeg -version 2>&1 | head -n1').toString().trim(); } catch (_) {}
  try { ytdlpVersion  = execSync('yt-dlp --version 2>&1').toString().trim(); } catch (_) {}
  try { denoVersion   = execSync('deno --version 2>&1 | head -n1').toString().trim(); } catch (_) {}
  try { xrayVersion   = execSync('xray version 2>&1 | head -n1').toString().trim(); } catch (_) {}

  const filters = {
    drawtext:  hasFilter('drawtext'),
    drawbox:   hasFilter('drawbox'),
    gradients: hasFilter('gradients'),
    overlay:   hasFilter('overlay'),
    subtitles: hasFilter('subtitles'),
  };
  const filtersOk = filters.drawbox && filters.overlay;
  const pillowRaqm = checkPillowRaqm();

  res.json({
    app: 'yt-studio',
    version: APP_VERSION,
    build: BUILD_TAG,
    ffmpeg: ffmpegVersion,
    ffmpeg_filters: filters,
    ffmpeg_ok: filtersOk,
    pillow_raqm: pillowRaqm,
    bengali_engine: pillowRaqm ? 'Pillow+libraqm+harfbuzz (perfect)' : 'fallback (may break)',
    ytdlp: ytdlpVersion,
    deno: denoVersion,
    deno_installed: !denoVersion.includes('unknown'),
    xray: xrayVersion,
    xray_installed: xray.isXrayInstalled(),
    cookies_present: fs.existsSync(process.env.COOKIES_FILE || '/app/data/cookies/cookies.txt'),
    proxy_configured: !!process.env.YTDLP_PROXY,
    vmess_configured: !!process.env.VMESS_LINK,
    google_oauth_configured: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    config_persisted: fs.existsSync(CONFIG_FILE),
    fonts_bundled: fs.existsSync(path.join(__dirname, 'public', 'fonts', 'HindSiliguri-Bold.ttf'))
                || fs.existsSync(path.join(__dirname, 'public', 'fonts', 'NotoSansBengali-Bold.ttf')),
    mic_icon_bundled: fs.existsSync(path.join(__dirname, 'public', 'mic.png')),
    node: process.version,
    uptime_sec: Math.floor(process.uptime()),
  });
});

app.use('/auth',              authRoutes);
// IMPORTANT: more specific routes MUST be mounted before the generic /api/jobs alias,
// otherwise Express dispatches /api/jobs/clipper into the generic router which then
// treats "clipper" as a :id param → 404 "not found".
app.use('/api/jobs/clipper',   jobsClipperRoutes);
app.use('/api/jobs/natok',     jobsNatokRoutes);
app.use('/api/jobs/bulk',      jobsBulkRoutes);
app.use('/api/jobs/subburner', jobsSubburnerRoutes);
app.use('/api/jobs',           jobsClipperRoutes);   // legacy alias → clipper (kept last)
app.use('/api/drive',         driveRoutes);
app.use('/api/telegram',      telegramRoutes);
app.use('/api/setup',         setupRoutes);

app.use('/files', express.static(DATA_DIR, {
  setHeaders: (res) => res.set('Cache-Control', 'no-store')
}));

app.use((err, req, res, next) => {
  logger.error('Unhandled error', err);
  res.status(500).json({ error: err.message || 'Internal Server Error' });
});

app.listen(PORT, () => {
  logger.info(`🚀 YT Studio v${APP_VERSION} (${BUILD_TAG}) running on port ${PORT}`);

  try { logger.info(`   ffmpeg : ${execSync('ffmpeg -version 2>&1 | head -n1').toString().trim()}`); }
  catch (_) { logger.warn('   ffmpeg : not found'); }

  const db = hasFilter('drawbox'), ov = hasFilter('overlay');
  logger.info(`   filters: ${db && ov ? '✓ drawbox ✓ overlay' : '❌ MISSING'}`);

  const pillowOK = checkPillowRaqm();
  logger.info(`   bengali: ${pillowOK ? '✓ Pillow+libraqm+harfbuzz (perfect Bengali shaping)' : '❌ libraqm missing — Bengali will break!'}`);

  const fontDir = path.join(__dirname, 'public', 'fonts');
  const hasFonts = fs.existsSync(path.join(fontDir, 'HindSiliguri-Bold.ttf'));
  logger.info(`   fonts  : ${hasFonts ? '✓ Hind Siliguri + Noto Sans Bengali' : '⚠ no Bengali fonts!'}`);
  logger.info(`   mic    : ${fs.existsSync(path.join(__dirname, 'public', 'mic.png')) ? '✓ mic.png bundled' : '⚠ missing'}`);

  try { logger.info(`   yt-dlp : ${execSync('yt-dlp --version 2>&1').toString().trim()}`); }
  catch (_) { logger.warn('   yt-dlp : not found'); }

  try { logger.info(`   deno   : ${execSync('deno --version 2>&1 | head -n1').toString().trim()}`); }
  catch (_) { logger.warn('   deno   : ✗ not installed (YouTube JS challenge may fail)'); }

  try { logger.info(`   xray   : ${execSync('xray version 2>&1 | head -n1').toString().trim()}`); }
  catch (_) { logger.warn('   xray   : not found'); }

  logger.info(`   Cookies: ${fs.existsSync(process.env.COOKIES_FILE || '/app/data/cookies/cookies.txt') ? '✓' : '✗'}`);
  logger.info(`   VMess  : ${process.env.VMESS_LINK ? '✓ link saved' : '✗ none'}`);
  logger.info(`   Proxy  : ${process.env.YTDLP_PROXY ? '✓ ' + process.env.YTDLP_PROXY.replace(/:[^:@]*@/, ':***@') : '✗ none'}`);
  const tgChannelsSet = ['TELEGRAM_CHAT_ID_WAZ', 'TELEGRAM_CHAT_ID_NATOK', 'TELEGRAM_CHAT_ID_BULK'].filter(k => process.env[k]).length;
  logger.info(`   Telegram: ${process.env.TELEGRAM_BOT_TOKEN ? `✓ bot token set, ${tgChannelsSet}/3 channel(s) configured` : '✗ TELEGRAM_BOT_TOKEN not set'}`);
  logger.info(`   Output : ${DATA_DIR}`);

  if (process.env.VMESS_LINK) {
    setTimeout(() => xray.startXray(), 1000);
  }
});

['SIGTERM', 'SIGINT'].forEach(sig => {
  process.on(sig, () => {
    logger.info(`Received ${sig}, shutting down...`);
    xray.stopXray();
    process.exit(0);
  });
});
