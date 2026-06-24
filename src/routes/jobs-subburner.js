'use strict';

const router = require('express').Router();
const path   = require('path');
const fs     = require('fs');
const multer = require('multer');
const { createJob, getJob, listJobs, deleteJob, saveStore } = require('../services/jobManager-subburner');
const { logger } = require('../utils/logger');

const OUTPUT_DIR = process.env.OUTPUT_DIR || '/app/data/output';
const SRT_DIR    = process.env.TEMP_DIR
  ? path.join(process.env.TEMP_DIR, 'srt-uploads')
  : '/tmp/srt-uploads';
const AUDIO_DIR  = process.env.TEMP_DIR
  ? path.join(process.env.TEMP_DIR, 'audio-uploads')
  : '/tmp/audio-uploads';

fs.mkdirSync(SRT_DIR,   { recursive: true });
fs.mkdirSync(AUDIO_DIR, { recursive: true });

// Multer storage — keep original extension so Python can read it
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, SRT_DIR),
  filename:    (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// Audio multer — larger limit (150MB WAV/MP3)
const audioStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, AUDIO_DIR),
  filename:    (_req, file, cb) => {
    cb(null, `${Date.now()}_sr_audio.wav`);
  },
});
const audioUpload = multer({ storage: audioStorage, limits: { fileSize: 150 * 1024 * 1024 } });

// ── POST /api/jobs/subburner/upload-srt ───────────────────────────────────────
router.post('/upload-srt', upload.single('srt'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'srt file required' });
  res.json({ ok: true, srtPath: req.file.path, originalName: req.file.originalname });
});

// ── POST /api/jobs/subburner/upload-audio ─────────────────────────────────────
router.post('/upload-audio', audioUpload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'audio file required' });
  res.json({ ok: true, audioPath: req.file.path, originalName: req.file.originalname });
});

// ── POST /api/jobs/subburner ──────────────────────────────────────────────────
router.post('/', (req, res) => {
  try {
    const {
      videoUrl, referer, srtPath, preset, crop169,
      mode, title, clips, targets,
      sources, recapMerge,           // recap mode fields

      // New common fields
      colorGrade, subPos, fontSize,  // color grading, subtitle position, font size
      bgm,                           // {url, start, end, volume} background music
      driveFolder,                   // Google Drive folder URL (all modes)

      // screenshot_recap fields
      sr_timestamps, sr_audio_path, sr_atempo, sr_drive_folder,
      sr_kb_effect, sr_ss_quality, sr_bgm,
    } = req.body || {};

    if (mode === 'recap') {
      if (!Array.isArray(sources) || !sources.length)
        return res.status(400).json({ error: 'sources[] required for recap mode' });
      for (const s of sources) {
        if (!s.url) return res.status(400).json({ error: 'each source must have url' });
        if (!Array.isArray(s.clips) || !s.clips.length)
          return res.status(400).json({ error: 'each source must have clips[]' });
      }
    } else if (mode === 'screenshot_recap') {
      if (!Array.isArray(sr_timestamps) || !sr_timestamps.length)
        return res.status(400).json({ error: 'sr_timestamps[] required for screenshot_recap mode' });
      if (!sr_audio_path)
        return res.status(400).json({ error: 'sr_audio_path required for screenshot_recap mode' });
      if (!fs.existsSync(sr_audio_path))
        return res.status(400).json({ error: `sr_audio_path not found: ${sr_audio_path}` });
      if (!videoUrl && (!Array.isArray(sources) || !sources.length))
        return res.status(400).json({ error: 'videoUrl or sources[] required for screenshot_recap' });
    } else {
      if (!videoUrl) return res.status(400).json({ error: 'videoUrl required' });
      if (mode === 'clip' && (!Array.isArray(clips) || !clips.length))
        return res.status(400).json({ error: 'clips[] required for clip mode' });
    }

    if (srtPath && !fs.existsSync(srtPath))
      return res.status(400).json({ error: `srtPath not found on server: ${srtPath}` });

    const job = createJob({
      videoUrl, referer, srtPath: srtPath || null, preset, crop169,
      mode, title, clips, targets, sources, recapMerge,

      // New common fields
      colorGrade: colorGrade || 'natural',
      subPos:     subPos     || 'bottom',
      fontSize:   fontSize   || 38,
      bgm:        bgm        || null,
      driveFolder: driveFolder || '',

      // screenshot_recap fields
      sr_timestamps, sr_audio_path, sr_atempo, sr_drive_folder,
      sr_kb_effect: sr_kb_effect || 'random',
      sr_ss_quality: sr_ss_quality || '2',
      sr_bgm: sr_bgm || null,
    });
    res.json({ ok: true, jobId: job.id, job });
  } catch (e) {
    logger.error('[subburner route]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/jobs/subburner ───────────────────────────────────────────────────
router.get('/', (_req, res) => res.json({ jobs: listJobs() }));

// ── GET /api/jobs/subburner/:id ───────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const j = getJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'not found' });
  res.json(j);
});

// ── DELETE /api/jobs/subburner/:id ────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  const ok = deleteJob(req.params.id);
  res.json({ ok, killed: ok });
});

// ── GET /api/jobs/subburner/:id/logs  (SSE) ───────────────────────────────────
router.get('/:id/logs', (req, res) => {
  res.set({
    'Content-Type':    'text/event-stream',
    'Cache-Control':   'no-cache',
    'Connection':      'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const tag = `[job:${req.params.id}]`;
  const { logger: lg } = require('../utils/logger');

  // Replay recent ring-buffer entries that belong to this job
  for (const e of lg.recent(300)) {
    if (e.line.includes(tag)) res.write(`data: ${JSON.stringify(e)}\n\n`);
  }

  const unsub = lg.subscribe(e => {
    if (e.line.includes(tag)) res.write(`data: ${JSON.stringify(e)}\n\n`);
  });
  req.on('close', () => unsub());
});

// ── GET /api/jobs/subburner/:id/files/:filename  (output download) ────────────
router.get('/:id/files/:filename', (req, res) => {
  const filePath = path.join(OUTPUT_DIR, 'subburner', req.params.id, req.params.filename);
  if (!fs.existsSync(filePath))
    return res.status(404).json({ error: 'file not found' });
  res.setHeader('Cache-Control', 'no-store');
  res.download(filePath);
});

// ── GET /api/jobs/subburner/:id/outputs/:outIdx/audio — extracted audio download ──
router.get('/:id/outputs/:outIdx/audio', (req, res) => {
  const j = getJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'job not found' });
  const extract = j.audioExtracts && j.audioExtracts[parseInt(req.params.outIdx)];
  if (!extract || !fs.existsSync(extract.path))
    return res.status(404).json({ error: 'audio not extracted yet' });
  res.download(extract.path, extract.file || 'audio.aac');
});

// ── POST /api/jobs/subburner/:id/outputs/:outIdx/audio — cleaned audio upload ──
const cleanedAudioStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(process.env.TEMP_DIR || '/tmp/waz', 'cleaned-audio');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `${Date.now()}_cleaned_${file.originalname}`),
});
const cleanedAudioUpload = multer({ storage: cleanedAudioStorage, limits: { fileSize: 500 * 1024 * 1024 } });

router.post('/:id/outputs/:outIdx/audio', cleanedAudioUpload.single('audio'), async (req, res) => {
  const j = getJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'job not found' });
  const outIdx = parseInt(req.params.outIdx);
  const extract = j.audioExtracts && j.audioExtracts[outIdx];
  if (!extract) return res.status(400).json({ error: 'no audio extract for this output' });
  if (!req.file) return res.status(400).json({ error: 'audio file required' });

  // Replace audio in original video
  const videoPath = extract.videoPath;
  if (!fs.existsSync(videoPath))
    return res.status(404).json({ error: 'original video not found' });

  const replacedOut = videoPath.replace('.mp4', '_audiorepl.mp4');
  const { spawn } = require('child_process');
  await new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', videoPath,
      '-i', req.file.path,
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
      '-shortest', replacedOut,
    ], { stdio: 'ignore' });
    proc.on('error', reject);
    proc.on('close', code => code === 0 ? resolve() : reject(new Error('audio replace failed')));
  });
  fs.renameSync(replacedOut, videoPath);

  j.audioExtracts[outIdx].cleanedAudioPath = req.file.path;
  j.audioExtracts[outIdx].waitingForAudio = false;
  saveStore();
  logger.info(`[subburner] cleaned audio applied for job ${req.params.id} output ${outIdx}`);
  res.json({ ok: true });
});

module.exports = router;
