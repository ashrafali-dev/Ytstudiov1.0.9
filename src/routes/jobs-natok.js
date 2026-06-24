'use strict';

const router = require('express').Router();
const { createJob, getJob, listJobs, deleteJob } = require('../services/jobManager-natok');
const { logger } = require('../utils/logger');

router.post('/', (req, res) => {
  try {
    const {
      url, speaker, defaultStyle, cropMode, clips, partial,
      colorGrade, musicUrl, musicVolume, musicStart, musicEnd,
      headerText, followText, ducking,
    } = req.body || {};

    if (!url || !String(url).trim()) {
      logger.warn('[natok route] reject: missing url. body keys =', Object.keys(req.body || {}));
      return res.status(400).json({ error: 'url required' });
    }
    if (!Array.isArray(clips) || !clips.length) {
      logger.warn('[natok route] reject: clips[] missing/empty');
      return res.status(400).json({ error: 'clips[] required (at least one clip or recap item)' });
    }

    // Accept range as string OR ranges as string/array. Title auto-fills if missing.
    function hasAnyRange(c) {
      if (Array.isArray(c.ranges) && c.ranges.some(r => String(r || '').trim())) return true;
      if (typeof c.ranges === 'string' && c.ranges.trim()) return true;
      if (c.range && String(c.range).trim()) return true;
      return false;
    }
    for (const [i, c] of clips.entries()) {
      if (!hasAnyRange(c)) {
        logger.warn(`[natok route] reject: clips[${i}] has no range/ranges`, c);
        return res.status(400).json({ error: `clips[${i}] needs a 'range' or 'ranges' (got: ${JSON.stringify(c).slice(0,120)})` });
      }
    }

    const job = createJob({
      url, speaker, defaultStyle, cropMode, clips, partial,
      colorGrade, musicUrl, musicVolume, musicStart, musicEnd,
      headerText, followText, ducking,
    });
    logger.info(`[natok route] ✓ job ${job.id} created with ${job.clips.length} clip(s)`);
    res.json({ ok: true, jobId: job.id, job });
  } catch (e) {
    logger.error(e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/',     (req, res) => res.json({ jobs: listJobs() }));
router.get('/:id',  (req, res) => {
  const j = getJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'not found' });
  res.json(j);
});
router.delete('/:id', (req, res) => {
  const ok = deleteJob(req.params.id);
  res.json({ ok, killed: ok });
});

router.get('/:id/logs', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const tag = `[job:${req.params.id}]`;
  const { logger: lg } = require('../utils/logger');
  for (const e of lg.recent(300)) {
    if (e.line.includes(tag)) res.write(`data: ${JSON.stringify(e)}\n\n`);
  }
  const unsub = lg.subscribe(e => {
    if (e.line.includes(tag)) res.write(`data: ${JSON.stringify(e)}\n\n`);
  });
  req.on('close', () => unsub());
});

module.exports = router;
