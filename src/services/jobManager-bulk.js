'use strict';

// =====================================================================
// YT Studio — Bulk Job Manager
//
// Inherits bulk-yt-downloader v3.0 job logic, plus:
//   • aborted set checked between items
//   • deleteJob kills active yt-dlp processes immediately
// =====================================================================

const { v4: uuid } = require('uuid');
const path = require('path');
const fs = require('fs');
const { logger } = require('../utils/logger');
const { downloadOne, killJob: killYtdlpJob } = require('./ytdlp-bulk');

const OUTPUT_DIR = process.env.OUTPUT_DIR || '/app/data/output';
const TEMP_DIR   = process.env.TEMP_DIR   || '/tmp/waz';

const STORE_FILE = path.join(OUTPUT_DIR, '_jobs-bulk.json');
let jobs = {};

// ── Global serial queue ──────────────────────────────────────────────
// Ensures only ONE job runs at a time.
// Prevents Railway OOM / ffmpeg frame-stuck caused by parallel jobs.
let _queueRunning = false;
const _queue = [];

function enqueueJob(id) {
  return new Promise((resolve, reject) => {
    _queue.push({ id, resolve, reject });
    _drainQueue();
  });
}

function _drainQueue() {
  if (_queueRunning || !_queue.length) return;
  _queueRunning = true;
  const { id, resolve, reject } = _queue.shift();
  runJob(id).then(resolve, reject).finally(() => {
    _queueRunning = false;
    _drainQueue();
  });
}
// ────────────────────────────────────────────────────────────────────
const aborted = new Set();

function loadStore() {
  try {
    if (fs.existsSync(STORE_FILE)) jobs = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch (e) { logger.warn('Could not load bulk job store:', e.message); }
}
function saveStore() {
  try {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(jobs, null, 2));
  } catch (_) {}
}
loadStore();

function normalizeUrl(url) {
  if (!url) return url;
  return String(url).trim().replace(/^(Https?|HTTPS?):/i, m => m.toLowerCase());
}

function splitUrls(text) {
  if (!text) return [];
  return String(text)
    .split(/[\n\r,;]+/)
    .map(l => l.trim())
    .filter(l => /^https?:\/\//i.test(l))
    .map(normalizeUrl);
}

const VALID_MODES = new Set(['video_audio', 'audio', 'video']);

function createJob(payload) {
  const id = uuid().slice(0, 8);
  const mode = VALID_MODES.has(payload.mode) ? payload.mode : 'video_audio';

  let urls = Array.isArray(payload.urls) ? payload.urls : splitUrls(payload.urlsText);
  urls = urls.map(normalizeUrl).filter(Boolean);

  if (!urls.length) throw new Error('No valid YouTube URLs provided');

  const job = {
    id,
    type: 'bulk',
    mode,
    status: 'queued',
    createdAt: Date.now(),
    finishedAt: null,
    items: urls.map((url, i) => ({
      index: i,
      url,
      status: 'pending',
      title: null,
      hashtags: [],
      fileName: null,
      strategy: null,
      sizeBytes: 0,
      durationMs: 0,
      error: null,
      driveFileId: null,
      telegramUploaded: false,
      telegramMessageId: null,
      telegramFileId: null,
    })),
    summary: { total: urls.length, ok: 0, failed: 0 },
    error: null,
  };
  jobs[id] = job;
  saveStore();
  setImmediate(() => enqueueJob(id));
  return job;
}

function checkAborted(id) {
  return aborted.has(id) || !jobs[id];
}

async function runJob(id) {
  const job = jobs[id];
  if (!job) return;
  const jl = logger.forJob(id);
  job.status = 'running';
  saveStore();

  jl.info(`📥 Bulk job started: ${job.items.length} URL(s), mode=${job.mode}`);

  for (const item of job.items) {
    if (checkAborted(id)) { jl.warn('Bulk job aborted by user.'); return; }
    item.status = 'downloading';
    saveStore();
    jl.info(`──────── [${item.index + 1}/${job.items.length}] ${item.url} ────────`);

    try {
      const result = await downloadOne(item.url, id, jl, { mode: job.mode });
      if (checkAborted(id)) {
        jl.warn('Aborted right after download — removing file.');
        try { fs.unlinkSync(result.filePath); } catch (_) {}
        return;
      }
      item.status     = 'ready';
      item.title      = result.title;
      item.hashtags   = result.hashtags;
      item.fileName   = result.fileName;
      item.strategy   = result.strategy;
      item.sizeBytes  = result.sizeBytes;
      item.durationMs = result.durationMs;
      job.summary.ok++;
      saveStore();
      jl.info(`✅ [${item.index + 1}] OK: ${result.fileName}`);
    } catch (e) {
      if (checkAborted(id)) { jl.warn('Aborted during item — bailing out.'); return; }
      item.status = 'failed';
      item.error  = (e && e.message ? e.message : String(e)).slice(0, 600);
      job.summary.failed++;
      saveStore();
      jl.error(`❌ [${item.index + 1}] FAILED — skipping. Reason: ${item.error.split('\n')[0]}`);
    }
  }

  if (!checkAborted(id)) {
    job.status = 'done';
    job.finishedAt = Date.now();
    saveStore();
    jl.info(`🏁 Bulk job complete: ${job.summary.ok}/${job.summary.total} OK, ${job.summary.failed} failed`);
  }

  try {
    const dir = path.join(TEMP_DIR, id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
  aborted.delete(id);
}

function getJob(id)  { return jobs[id] || null; }
function listJobs()  {
  return Object.values(jobs).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
}

function deleteJob(id) {
  const j = jobs[id];
  if (!j) return false;

  aborted.add(id);
  const killed = killYtdlpJob(id);
  if (killed) logger.info(`[job:${id}] killed ${killed} yt-dlp proc(s)`);

  for (const it of j.items) {
    if (it.fileName) {
      try { fs.unlinkSync(path.join(OUTPUT_DIR, it.fileName)); } catch (_) {}
    }
  }
  try {
    const dir = path.join(TEMP_DIR, id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}

  delete jobs[id];
  saveStore();
  return true;
}

module.exports = { createJob, getJob, listJobs, deleteJob, saveStore };
