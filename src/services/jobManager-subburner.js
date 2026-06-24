'use strict';

// =====================================================================
// YT Studio — Sub Burner Job Manager
//
// Calls sub_burner.py as a Python subprocess.
// sub_burner.py emits JSON lines to stdout; we parse them and
// broadcast to the shared ring-buffer logger (same SSE pattern as
// the Waz Clipper).
// =====================================================================

const { v4: uuid } = require('uuid');
const path         = require('path');
const fs           = require('fs');
const { spawn }    = require('child_process');
const { logger }   = require('../utils/logger');

const OUTPUT_DIR  = process.env.OUTPUT_DIR  || '/app/data/output';
const CONFIG_FILE = process.env.CONFIG_FILE || '/app/data/config.json';

const STORE_FILE    = path.join(OUTPUT_DIR, '_jobs-subburner.json');
const PYTHON_SCRIPT = path.join(__dirname, '..', '..', 'sub_burner.py');
// Prefer the venv python; fall back to system python3
const PYTHON_BIN    = fs.existsSync('/opt/venv/bin/python3')
  ? '/opt/venv/bin/python3'
  : 'python3';

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
const aborted     = new Set();
const activeProcs = new Map(); // jobId → child process

function loadStore() {
  try {
    if (fs.existsSync(STORE_FILE))
      jobs = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch (e) {
    logger.warn('[subburner] Could not load job store:', e.message);
  }
}
function saveStore() {
  try {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(jobs, null, 2));
  } catch (_) {}
}
loadStore();

// ── config helpers ────────────────────────────────────────────────────────────

function loadAppConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE))
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (_) {}
  return {};
}

function buildUploadsConfig(targets) {
  const cfg = loadAppConfig();
  const uploads = {};

  if (targets.includes('telegram')) {
    const enabled = !!(cfg.TG_BOT_TOKEN && cfg.TG_CHAT_ID);
    if (!enabled) logger.warn('[subburner] Telegram target selected but TG_BOT_TOKEN/TG_CHAT_ID not set in config');
    uploads.telegram = {
      enabled,
      bot_token: cfg.TG_BOT_TOKEN || '',
      chat_id:   cfg.TG_CHAT_ID   || '',
    };
  }

  if (targets.includes('facebook')) {
    const enabled = !!(cfg.FB_PAGE_TOKEN && cfg.FB_PAGE_ID);
    if (!enabled) logger.warn('[subburner] Facebook target selected but FB_PAGE_TOKEN/FB_PAGE_ID not set in config');
    uploads.facebook = {
      enabled,
      page_token: cfg.FB_PAGE_TOKEN || '',
      page_id:    cfg.FB_PAGE_ID    || '',
    };
  }

  if (targets.includes('youtube')) {
    const enabled = !!(cfg.YT_ACCESS_TOKEN);
    if (!enabled) logger.warn('[subburner] YouTube target selected but YT_ACCESS_TOKEN not set in config');
    uploads.youtube = {
      enabled,
      access_token: cfg.YT_ACCESS_TOKEN || '',
    };
  }

  return uploads;
}

// ── createJob ─────────────────────────────────────────────────────────────────

function createJob(payload) {
  const id = uuid().slice(0, 8);

  const job = {
    id,
    type:       'subburner',
    mode:       payload.mode      || 'full',
    videoUrl:   payload.videoUrl  || '',
    referer:    payload.referer   || '',
    srtPath:    payload.srtPath   || null,
    preset:     payload.preset    || '1',
    crop169:    !!payload.crop169,
    title:      payload.title     || 'SubBurner Video',
    clips:      Array.isArray(payload.clips)   ? payload.clips   : [],
    sources:    Array.isArray(payload.sources) ? payload.sources : [],  // recap mode
    recapMerge: !!payload.recapMerge,
    targets:    Array.isArray(payload.targets) ? payload.targets : [],

    // ── New fields ──────────────────────────────────────────────────
    colorGrade:   payload.colorGrade  || 'natural',   // none|natural|bright|vivid|warm|cinema
    subPos:       payload.subPos      || 'bottom',    // top|middle|bottom
    fontSize:     payload.fontSize    || 38,          // px, 24-56
    bgm: payload.bgm && payload.bgm.url ? {
      url:    payload.bgm.url    || '',
      start:  payload.bgm.start  || '',
      end:    payload.bgm.end    || '',
      volume: payload.bgm.volume || 30,
    } : null,
    driveFolder:  payload.driveFolder || '',          // global Drive folder for all modes

    // ── screenshot_recap specific fields ───────────────────────────
    sr_timestamps:   Array.isArray(payload.sr_timestamps) ? payload.sr_timestamps : [],
    sr_audio_path:   payload.sr_audio_path   || '',
    sr_atempo:       payload.sr_atempo       || 0.85,
    sr_drive_folder: payload.sr_drive_folder || '',
    sr_kb_effect:    payload.sr_kb_effect    || 'random',  // Ken Burns effect mode
    sr_ss_quality:   payload.sr_ss_quality   || '2',       // Screenshot quality (q value)
    sr_bgm: payload.sr_bgm && payload.sr_bgm.url ? {
      url:    payload.sr_bgm.url    || '',
      start:  payload.sr_bgm.start  || '',
      end:    payload.sr_bgm.end    || '',
      volume: payload.sr_bgm.volume || 25,
    } : null,

    extractAudio: !!payload.extractAudio,  // optional audio extract mode
    audioExtracts: {},   // { outputIndex: { path, file, waitingForAudio, cleanedAudioPath } }
    progress:   0,
    createdAt:  Date.now(),
    finishedAt: null,
    outputs:    [],
    error:      null,
  };

  jobs[id] = job;
  saveStore();
  setImmediate(() => enqueueJob(id));
  return job;
}

// ── runJob ────────────────────────────────────────────────────────────────────

async function runJob(id) {
  const job = jobs[id];
  if (!job) return;

  const jl = logger.forJob(id);
  job.status   = 'running';
  job.progress = 0;
  saveStore();

  // Per-job working directory inside OUTPUT_DIR
  const jobDir = path.join(OUTPUT_DIR, 'subburner', id);
  fs.mkdirSync(jobDir, { recursive: true });

  // Build the Python config object
  const pyConfig = {
    job_id:      id,
    mode:        job.mode,
    video_url:   job.videoUrl,
    referer:     job.referer,
    srt_path:    job.srtPath,
    preset:      job.preset,
    crop_169:    job.crop169,
    output_dir:  jobDir,
    title:       job.title,
    uploads:     buildUploadsConfig(job.targets),
    clips:       job.clips,
    sources:     job.sources,     // recap mode: [{url, referer, clips:[{start,end}]}]
    recap_merge: job.recapMerge,  // true = সব clips concat করে একটা video

    // ── New fields passed to Python ──────────────────────────────
    color_grade:  job.colorGrade,
    sub_pos:      job.subPos,
    font_size:    job.fontSize,
    bgm:          job.bgm || null,        // {url, start, end, volume} or null
    drive_folder: job.driveFolder || '',

    // ── screenshot_recap fields ──────────────────────────────────
    sr_timestamps:   job.sr_timestamps   || [],
    sr_audio_path:   job.sr_audio_path   || '',
    sr_atempo:       job.sr_atempo       || 0.85,
    sr_drive_folder: job.sr_drive_folder || '',
    sr_kb_effect:    job.sr_kb_effect    || 'random',
    sr_ss_quality:   job.sr_ss_quality   || '2',
    sr_bgm:          job.sr_bgm || null,  // {url, start, end, volume} or null
  };

  const configPath = path.join(jobDir, 'job_config.json');
  fs.writeFileSync(configPath, JSON.stringify(pyConfig, null, 2));

  jl.info(`🔥 Sub Burner starting (mode=${job.mode}, preset=${job.preset}, crop169=${job.crop169})`);
  jl.info(`   Color: ${job.colorGrade} | subPos: ${job.subPos} | fontSize: ${job.fontSize}px`);
  if (job.bgm) jl.info(`   BGM: ${job.bgm.url.slice(0, 60)} vol=${job.bgm.volume}%`);
  if (job.driveFolder) jl.info(`   Drive: ${job.driveFolder.slice(0, 60)}`);
  if (job.mode === 'recap') {
    jl.info(`   Sources: ${job.sources.length} URL(s), recap_merge=${job.recapMerge}`);
  } else {
    jl.info(`   Video : ${job.videoUrl}`);
  }
  jl.info(`   Title : ${job.title}`);
  jl.info(`   Upload: ${job.targets.join(', ') || '(none)'}`);

  const child = spawn(PYTHON_BIN, [PYTHON_SCRIPT, '--config', configPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      FFMPEG_HTTP_PROXY: process.env.FFMPEG_HTTP_PROXY || '',
    },
  });
  activeProcs.set(id, child);

  // Job-level timeout: min 30min, +10min per clip — kills stuck Python/FFmpeg
  const clipCount = Array.isArray(job.clips) ? job.clips.length : (Array.isArray(job.sources) ? job.sources.length : 1);
  const jobTimeoutMs = Math.max(1800, clipCount * 600) * 1000;
  const jobTimer = setTimeout(() => {
    jl.warn(`⏰ Sub Burner job timeout after ${Math.round(jobTimeoutMs/60000)}min — killing stuck process`);
    try { child.kill('SIGKILL'); } catch (_) {}
    const j = jobs[id];
    if (j && j.status === 'running') {
      j.status = 'failed';
      j.error = `Job timeout after ${Math.round(jobTimeoutMs/60000)} minutes`;
      j.finishedAt = Date.now();
      saveStore();
    }
  }, jobTimeoutMs);

  // Parse stdout JSON lines
  let buf = '';
  child.stdout.on('data', chunk => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop(); // keep incomplete line
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        handlePyEvent(id, jl, obj);
      } catch (_) {
        jl.info(line); // plain text fallback
      }
    }
  });

  // stderr → warn log (Python tracebacks, etc.)
  child.stderr.on('data', chunk => {
    const lines = chunk.toString().split('\n');
    for (const l of lines) {
      const t = l.trim();
      if (t) jl.warn(`[py] ${t}`);
    }
  });

  child.on('close', code => {
    clearTimeout(jobTimer);
    activeProcs.delete(id);
    if (aborted.has(id)) {
      jl.warn('Job aborted by user.');
      aborted.delete(id);
      return;
    }
    const j2 = jobs[id];
    if (!j2) return;
    if (code !== 0 && j2.status === 'done') {
      jl.warn(`⚠ Python exited ${code} after job was already marked done — treating as success.`);
      saveStore();
    } else if (code !== 0 && j2.status !== 'failed') {
      j2.status    = 'failed';
      j2.error     = `Python exited with code ${code}`;
      j2.finishedAt = Date.now();
      jl.error(`❌ Python process exited: code ${code}`);
      saveStore();
    } else if (j2.status === 'running') {
      j2.status    = 'done';
      j2.finishedAt = Date.now();
      saveStore();
      jl.info('🏁 Job finished.');
    }
  });
}

function handlePyEvent(id, jl, obj) {
  const job = jobs[id];
  if (!job) return;

  switch (obj.type) {
    case 'log': {
      const fn = jl[obj.level] || jl.info;
      fn.call(jl, obj.msg);
      break;
    }
    case 'progress': {
      job.progress = obj.pct;
      saveStore();
      if (obj.pct % 10 === 0 || obj.stage === 'done') {
        jl.info(`⏳ ${obj.pct}% [${obj.stage}]`);
      }
      break;
    }
    case 'clip_start': {
      jl.info(`🎬 Clip ${obj.index + 1} starting: "${obj.title}"`);
      break;
    }
    case 'clip_done': {
      if (obj.status === 'ready') {
        const outputIdx = job.outputs.length;
        job.outputs.push({
          clip:  obj.index + 1,
          title: obj.title,
          file:  obj.file,
          links: obj.links || {},
        });
        jl.info(`✅ Clip ${obj.index + 1} ready: ${obj.file}`);

        // ── Audio Extract (optional) ──────────────────────────────
        if (job.extractAudio && obj.file) {
          const videoPath = obj.file; // Python sends full path
          if (fs.existsSync(videoPath)) {
            const audioOut = videoPath.replace(/\.mp4$/i, '_audio.aac');
            jl.info(`🎵 Extracting audio for clip ${obj.index + 1}...`);
            const { spawn: sp } = require('child_process');
            const proc = sp('ffmpeg', [
              '-hide_banner', '-loglevel', 'error', '-y',
              '-i', videoPath,
              '-vn', '-acodec', 'copy',
              audioOut,
            ], { stdio: 'ignore' });
            proc.on('close', code => {
              if (code === 0) {
                job.audioExtracts[outputIdx] = {
                  path: audioOut,
                  file: path.basename(audioOut),
                  videoPath,
                  waitingForAudio: true,
                  cleanedAudioPath: null,
                };
                saveStore();
                jl.info(`⏸ Audio extracted, waiting for cleaned upload: ${path.basename(audioOut)}`);
              } else {
                jl.warn(`audio extract failed for clip ${obj.index + 1}`);
              }
            });
          }
        }
        // ─────────────────────────────────────────────────────────
      } else {
        jl.error(`❌ Clip ${obj.index + 1} failed: ${obj.title}`);
      }
      saveStore();
      break;
    }
    case 'done': {
      if (aborted.has(id)) break;
      job.status    = 'done';
      job.progress  = 100;
      job.finishedAt = Date.now();
      if (Array.isArray(obj.outputs) && obj.outputs.length) {
        job.outputs = obj.outputs;
      }
      jl.info('🏁 Job done');
      saveStore();
      break;
    }
    case 'error': {
      job.status    = 'failed';
      job.error     = obj.msg;
      job.finishedAt = Date.now();
      jl.error(`❌ Error: ${obj.msg}`);
      saveStore();
      break;
    }
    default:
      break;
  }
}

// ── public API ────────────────────────────────────────────────────────────────

function getJob(id)  { return jobs[id] || null; }
function listJobs()  {
  return Object.values(jobs)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50);
}

function deleteJob(id) {
  const j = jobs[id];
  if (!j) return false;

  aborted.add(id);

  const child = activeProcs.get(id);
  if (child) {
    try { child.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 3000);
    activeProcs.delete(id);
  }

  // Clean up job output directory
  const jobDir = path.join(OUTPUT_DIR, 'subburner', id);
  try { if (fs.existsSync(jobDir)) fs.rmSync(jobDir, { recursive: true, force: true }); } catch (_) {}

  delete jobs[id];
  saveStore();
  return true;
}

module.exports = { createJob, getJob, listJobs, deleteJob, saveStore };
