'use strict';

// =====================================================================
// YT Studio — Clipper download service (waz-clipper v2.6, POT REMOVED)
//
// Inherits all of waz v2.6's per-clip partial download logic, with the
// POT (BotGuard) provider integration fully stripped per user request.
// =====================================================================

const YTDLP_MODULE_VERSION = '2.7.0-progressive-fast';

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const stats = require('./stats');
const { ffTime, parseRange } = require('../utils/timestamp');

const COOKIES_FILE = process.env.COOKIES_FILE || '/app/data/cookies/cookies.txt';
const TEMP_DIR     = process.env.TEMP_DIR     || '/tmp/waz';

// ---------- Deno JS runtime detection (shared bypass with bulk) ----------
let DENO_BIN = null;
function detectDeno() {
  if (DENO_BIN !== null) return DENO_BIN;
  for (const candidate of ['/usr/local/bin/deno', '/usr/bin/deno', 'deno']) {
    try {
      execSync(`${candidate} --version`, { stdio: 'pipe' });
      DENO_BIN = candidate;
      return DENO_BIN;
    } catch (_) {}
  }
  DENO_BIN = '';
  return DENO_BIN;
}

function detectProxyType() {
  const link = process.env.VMESS_LINK || '';
  if (/^vmess:/i.test(link))   return 'vmess';
  if (/^vless:/i.test(link))   return 'vless';
  if (/^trojan:/i.test(link))  return 'trojan';
  if (/^ss:/i.test(link))      return 'shadowsocks';
  if (/^socks5/i.test(link))   return 'socks5';
  const proxy = process.env.YTDLP_PROXY || '';
  if (/^socks5/i.test(proxy))  return 'socks5';
  if (/^https?:\/\//i.test(proxy)) return 'http-proxy';
  return 'direct';
}

function buildCommonArgs(jobLog) {
  const proxyType = detectProxyType();
  const isSocks   = proxyType === 'socks5';
  const denoBin   = detectDeno();

  const args = [
    '--no-warnings',
    '--no-progress',
    '--newline',
    '--no-playlist',
    '--retries', '10',
    '--fragment-retries', '10',
    '--retry-sleep', '3',
    '--socket-timeout', '60',
    '--user-agent',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    '--add-header', 'Accept-Language:en-US,en;q=0.9',
    '--geo-bypass',
    '--referer', 'https://www.youtube.com/',
    '--add-header', 'Origin:https://www.youtube.com',
  ];

  // Parallel chunking — same as bulk v3.0.5 (works over VMess/SOCKS5 tunnel too)
  args.push(
    '--hls-prefer-native',
    '--concurrent-fragments', '4',
    '-N', '4',
    '--http-chunk-size', '10M',
  );
  if (isSocks) {
    if (jobLog) jobLog.info('🔧 VMess/SOCKS5 mode: parallel chunking (4 connections, 10M chunks)');
  } else {
    if (jobLog) jobLog.info('🔧 Direct mode: parallel chunking (4 connections, 10M chunks)');
  }

  // Deno JS runtime — required for yt-dlp 2025.11+ JS challenge
  if (denoBin) {
    args.push('--extractor-args', `youtube:jsruntime=deno`);
    if (jobLog) jobLog.info(`✓ Deno JS runtime: ${denoBin}`);
  } else if (jobLog) {
    jobLog.warn('⚠ Deno not installed — YouTube JS challenge may fail');
  }

  if (fs.existsSync(COOKIES_FILE) && fs.statSync(COOKIES_FILE).size > 100) {
    args.push('--cookies', COOKIES_FILE);
    if (jobLog) jobLog.info(`✓ cookies: ${COOKIES_FILE}`);
  } else if (jobLog) {
    jobLog.warn(`⚠ No cookies.txt found at ${COOKIES_FILE}`);
  }

  if (process.env.YTDLP_PROXY) {
    args.push('--proxy', process.env.YTDLP_PROXY);
    if (jobLog) jobLog.info(`✓ proxy: ${process.env.YTDLP_PROXY.replace(/:[^:@]*@/, ':***@')} (type: ${proxyType})`);
  }

  return args;
}

const STRATEGIES = [
  { name: 'web_embedded', client: 'web_embedded', desc: 'embeddable only, best success rate' },
  { name: 'mweb',         client: 'mweb',         desc: 'mobile web' },
  { name: 'ios',          client: 'ios',          desc: 'iOS client, bypasses most restrictions' },
  { name: 'android',      client: 'android',      desc: 'Android client, strong bypass' },
  { name: 'web_safari',   client: 'web_safari',   desc: 'HLS, cookie-friendly, no PO required' },
  { name: 'tv_simply',    client: 'tv_simply',    desc: 'no PO, no cookies needed' },
  { name: 'android_vr',   client: 'android_vr',   desc: 'kids-safe fallback' },
];

// Track running child processes per-job so deleteJob can kill them
const RUNNING = new Map();   // jobId → Set<ChildProcess>
function trackProc(jobId, proc) {
  if (!RUNNING.has(jobId)) RUNNING.set(jobId, new Set());
  RUNNING.get(jobId).add(proc);
  proc.on('close', () => {
    const set = RUNNING.get(jobId);
    if (set) { set.delete(proc); if (!set.size) RUNNING.delete(jobId); }
  });
}
function killJob(jobId) {
  const set = RUNNING.get(jobId);
  if (!set) return 0;
  let n = 0;
  for (const p of set) {
    try { p.kill('SIGKILL'); n++; } catch (_) {}
  }
  RUNNING.delete(jobId);
  return n;
}

function runYtdlpOnce(args, jobLog, jobId) {
  return new Promise((resolve, reject) => {
    jobLog.info('yt-dlp', args.map(a => a.includes(' ') ? `"${a}"` : a).join(' '));
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (jobId) trackProc(jobId, proc);
    let stderrBuf = '', stdoutBuf = '';
    proc.stdout.on('data', d => {
      const s = d.toString(); stdoutBuf += s;
      s.split(/\r?\n/).forEach(line => { if (line) jobLog.info(`yt-dlp> ${line}`); });
    });
    proc.stderr.on('data', d => {
      const text = d.toString(); stderrBuf += text;
      text.split(/\r?\n/).forEach(line => {
        if (!line) return;
        if (/WARNING/i.test(line)) jobLog.warn(`yt-dlp> ${line}`);
        else jobLog.error(`yt-dlp> ${line}`);
      });
    });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve({ stdout: stdoutBuf, stderr: stderrBuf });
      else reject(Object.assign(new Error(`yt-dlp exited ${code}`), { code, stderr: stderrBuf }));
    });
  });
}

async function downloadOneSection(url, workDir, sectionIndex, range, jobLog, hasCookies, proxyType, jobId) {
  const { start, end } = parseRange(range);
  const padStart = Math.max(0, start - 2);
  const padEnd   = end + 2;

  const sectionStr = `*${ffTime(padStart)}-${ffTime(padEnd)}`;
  const baseName   = `source_${String(sectionIndex).padStart(2, '0')}`;
  const outTpl     = path.join(workDir, `${baseName}.%(ext)s`);

  jobLog.info(`━━━ Section ${sectionIndex}: original ${ffTime(start)}→${ffTime(end)} (padded ${ffTime(padStart)}→${ffTime(padEnd)}) ━━━`);

  try {
    for (const f of fs.readdirSync(workDir)) {
      if (f.startsWith(baseName)) fs.unlinkSync(path.join(workDir, f));
    }
  } catch (_) {}

  const commonArgs = buildCommonArgs(jobLog);
  const errors = [];

  for (let i = 0; i < STRATEGIES.length; i++) {
    const strategy = STRATEGIES[i];
    jobLog.info(`  → strategy ${i + 1}/${STRATEGIES.length}: ${strategy.name}`);

    const args = [
      ...commonArgs,
      '--extractor-args', `youtube:player_client=${strategy.client}`,
      '--download-sections', sectionStr,
      '-f', 'b[height<=720][ext=mp4][protocol*=https]/b[height<=480][ext=mp4][protocol*=https]/b[height<=360][ext=mp4][protocol*=https]/bv*[height<=720][ext=mp4]+ba[ext=m4a]/bv*+ba/b[ext=mp4]/b',
      '--merge-output-format', 'mp4',
      '-o', outTpl,
      url,
    ];

    const startMs = Date.now();
    try {
      await runYtdlpOnce(args, jobLog, jobId);
      const files = fs.readdirSync(workDir).filter(f => f.startsWith(baseName + '.') && !f.endsWith('.part'));
      if (!files.length) throw new Error('finished but no source file produced');
      const result = path.join(workDir, files[0]);
      const elapsed = Date.now() - startMs;
      const sizeMB = (fs.statSync(result).size / (1024 * 1024)).toFixed(1);
      jobLog.info(`  ✅ Section ${sectionIndex} via "${strategy.name}" in ${(elapsed/1000).toFixed(1)}s (${sizeMB} MB)`);

      stats.record({
        url, success: true, strategy: strategy.name,
        proxyType, hasCookies, hasPOT: false,
        duration_ms: elapsed,
        partial: true,
      });
      return { path: result, sectionStart: padStart, sectionEnd: padEnd };
    } catch (e) {
      const elapsed = Date.now() - startMs;
      const isBotError = /Sign in to confirm|not a bot|requires.*login/i.test(e.stderr || e.message || '');
      const isFormatError = /requested format|no video formats|HTTP Error 4\d\d/i.test(e.stderr || '');
      const reason = isBotError ? 'BOT_DETECTION' : isFormatError ? 'FORMAT_UNAVAILABLE' : 'OTHER';
      jobLog.warn(`  ✗ "${strategy.name}" failed (${reason}) after ${(elapsed/1000).toFixed(1)}s`);
      errors.push(`[${strategy.name}] ${(e.message || '').slice(0, 200)}`);
    }
  }

  stats.record({
    url, success: false, strategy: 'all_exhausted',
    proxyType, hasCookies, hasPOT: false, duration_ms: 0,
    error: errors.slice(0, 2).join(' | '),
  });

  throw new Error(
    `Section ${sectionIndex} failed on all ${STRATEGIES.length} strategies.\n` +
    `Errors:\n  → ${errors.join('\n  → ')}`
  );
}

async function downloadFull(url, workDir, jobLog, hasCookies, proxyType, jobId) {
  const commonArgs = buildCommonArgs(jobLog);
  const errors = [];

  try {
    for (const f of fs.readdirSync(workDir)) {
      if (f.startsWith('source.') || f.endsWith('.part')) fs.unlinkSync(path.join(workDir, f));
    }
  } catch (_) {}

  for (let i = 0; i < STRATEGIES.length; i++) {
    const strategy = STRATEGIES[i];
    jobLog.info(`━━━ Full DL strategy ${i + 1}/${STRATEGIES.length}: ${strategy.name} ━━━`);
    const outTpl = path.join(workDir, 'source.%(ext)s');
    const args = [
      ...commonArgs,
      '--extractor-args', `youtube:player_client=${strategy.client}`,
      '-f', 'b[height<=720][ext=mp4][protocol*=https]/b[height<=480][ext=mp4][protocol*=https]/b[height<=360][ext=mp4][protocol*=https]/bv*[height<=720][ext=mp4]+ba[ext=m4a]/bv*+ba/b[ext=mp4]/b',
      '--merge-output-format', 'mp4',
      '-o', outTpl,
      url,
    ];
    const startMs = Date.now();
    try {
      await runYtdlpOnce(args, jobLog, jobId);
      const files = fs.readdirSync(workDir).filter(f => f.startsWith('source.') && !f.endsWith('.part'));
      if (!files.length) throw new Error('finished but no source file produced');
      const result = path.join(workDir, files[0]);
      const elapsed = Date.now() - startMs;
      const sizeMB = (fs.statSync(result).size / (1024 * 1024)).toFixed(1);
      jobLog.info(`✅ Full download via "${strategy.name}" in ${(elapsed/1000).toFixed(1)}s (${sizeMB} MB)`);
      stats.record({
        url, success: true, strategy: strategy.name,
        proxyType, hasCookies, hasPOT: false, duration_ms: elapsed, partial: false,
      });
      return { path: result, sectionStart: 0, sectionEnd: null };
    } catch (e) {
      jobLog.warn(`✗ Full DL "${strategy.name}" failed: ${(e.message || '').slice(0, 200)}`);
      errors.push(`[${strategy.name}] ${(e.message || '').slice(0, 200)}`);
    }
  }
  stats.record({
    url, success: false, strategy: 'all_exhausted',
    proxyType, hasCookies, hasPOT: false, duration_ms: 0,
    error: errors.slice(0, 2).join(' | '),
  });
  throw new Error(`All ${STRATEGIES.length} full-download strategies failed.\n  → ${errors.join('\n  → ')}`);
}

async function downloadVideo(url, jobId, jobLog, opts = {}) {
  jobLog.info(`[ytdlp-module=${YTDLP_MODULE_VERSION}] Starting download for: ${url}`);

  const workDir = path.join(TEMP_DIR, jobId);
  fs.mkdirSync(workDir, { recursive: true });

  const proxyType  = detectProxyType();
  const hasCookies = fs.existsSync(COOKIES_FILE) && fs.statSync(COOKIES_FILE).size > 100;

  const partial = opts.partial && Array.isArray(opts.clipRanges) && opts.clipRanges.length;

  if (partial) {
    jobLog.info(`📌 PARTIAL MODE (per-clip): ${opts.clipRanges.length} section(s) — each downloaded to its own file`);

    const sources = [];
    for (let idx = 0; idx < opts.clipRanges.length; idx++) {
      const range = opts.clipRanges[idx];
      try {
        const dl = await downloadOneSection(
          url, workDir, idx + 1, range, jobLog, hasCookies, proxyType, jobId,
        );
        sources.push({
          clipIndex: idx,
          range,
          sourcePath: dl.path,
          sectionStart: dl.sectionStart,
          sectionEnd: dl.sectionEnd,
        });
      } catch (e) {
        jobLog.error(`❌ Section ${idx + 1} (${range}) failed: ${e.message}`);
        sources.push({
          clipIndex: idx,
          range,
          sourcePath: null,
          sectionStart: null,
          sectionEnd: null,
          error: e.message,
        });
      }
    }

    const ok = sources.filter(s => s.sourcePath).length;
    if (ok === 0) {
      throw new Error('All sections failed to download. See logs.');
    }
    jobLog.info(`📦 Partial download complete: ${ok}/${sources.length} sections OK`);
    return { mode: 'partial', sources };
  }

  const dl = await downloadFull(url, workDir, jobLog, hasCookies, proxyType, jobId);
  const sources = (opts.clipRanges || [null]).map((range, idx) => ({
    clipIndex: idx,
    range,
    sourcePath: dl.path,
    sectionStart: 0,
    sectionEnd: dl.sectionEnd,
  }));
  return { mode: 'full', sources };
}

module.exports = {
  downloadVideo,
  YTDLP_MODULE_VERSION,
  STRATEGIES,
  detectDeno,
  detectProxyType,
  buildCommonArgs,
  killJob,
};
