'use strict';

// =====================================================================
// YT Studio — Unified Telegram upload route
//
// Mirrors routes/drive.js: supports BOTH clipper/natok jobs (have
// `clips[]`) and bulk jobs (have `items[]`). We auto-detect the job
// type by looking it up in all three job managers, same precedence
// drive.js uses (natok wins over clipper since natok jobs are also
// stored in the clipper-shaped store).
//
// This is a fully separate, optional upload path — it never reads or
// mutates anything Drive-related, so Drive keeps working exactly as
// before whether or not Telegram is configured.
// =====================================================================

const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const { uploadFile, resolveChannel } = require('../services/telegram');
const clipperJM = require('../services/jobManager-clipper');
const natokJM   = require('../services/jobManager-natok');
const bulkJM    = require('../services/jobManager-bulk');
const { logger } = require('../utils/logger');

const OUTPUT_DIR = process.env.OUTPUT_DIR || '/app/data/output';

router.post('/upload', async (req, res) => {
  try {
    const { jobId, channel, indices } = req.body || {};
    if (!jobId)   return res.status(400).json({ error: 'jobId required' });
    if (!channel) return res.status(400).json({ error: 'channel required' });

    const target = resolveChannel(channel);
    if (!target)        return res.status(400).json({ error: `unknown channel "${channel}"` });
    if (!target.chatId) return res.status(400).json({ error: `${target.label} এর chat_id সেট করা নেই (env var: ${target.chatIdEnv})` });

    // Lookup in all managers — same precedence as drive.js
    const clipperJob = clipperJM.getJob(jobId);
    const natokJob   = natokJM.getJob(jobId);
    const bulkJob    = bulkJM.getJob(jobId);
    const job = natokJob || clipperJob || bulkJob;
    if (!job) return res.status(404).json({ error: 'job not found' });

    const ownerJM   = natokJob ? natokJM : (clipperJob ? clipperJM : bulkJM);
    const isClipper = !!(clipperJob || natokJob);
    const jl = logger.forJob(jobId);
    const results = [];

    if (isClipper) {
      let targets = job.clips.filter(c => c.status === 'ready' && c.filename);
      if (Array.isArray(indices) && indices.length) {
        const set = new Set(indices.map(Number));
        targets = targets.filter(c => set.has(c.index));
      }
      if (!targets.length) return res.status(400).json({ error: 'no ready clips selected' });

      for (const clip of targets) {
        const fp = path.join(OUTPUT_DIR, clip.filename);
        if (!fs.existsSync(fp)) {
          results.push({ index: clip.index, ok: false, error: 'file missing' });
          continue;
        }
        try {
          const caption = clip.title || `Clip ${clip.index + 1}`;
          const r = await uploadFile(target.chatId, fp, caption);
          clip.telegramUploaded  = true;
          clip.telegramMessageId = r.messageId;
          clip.telegramFileId    = r.fileId;
          jl.info(`📨 Telegram upload OK → ${target.label} (clip ${clip.index + 1}, ${r.method}): message_id ${r.messageId}`);
          results.push({ index: clip.index, ok: true, messageId: r.messageId, fileId: r.fileId });
        } catch (e) {
          logger.error('Telegram upload failed:', e);
          jl.error(`❌ Telegram upload failed (clip ${clip.index + 1} → ${target.label}): ${e.message}`);
          results.push({ index: clip.index, ok: false, error: e.message });
        }
      }
    } else {
      let targets = job.items.filter(it => it.status === 'ready' && it.fileName);
      if (Array.isArray(indices) && indices.length) {
        const set = new Set(indices.map(Number));
        targets = targets.filter(it => set.has(it.index));
      }
      if (!targets.length) return res.status(400).json({ error: 'no ready items to upload' });

      for (const item of targets) {
        const fp = path.join(OUTPUT_DIR, item.fileName);
        if (!fs.existsSync(fp)) {
          results.push({ index: item.index, ok: false, error: 'file missing' });
          continue;
        }
        try {
          const caption = item.title || item.fileName;
          const r = await uploadFile(target.chatId, fp, caption);
          item.telegramUploaded  = true;
          item.telegramMessageId = r.messageId;
          item.telegramFileId    = r.fileId;
          jl.info(`📨 Telegram upload OK → ${target.label} (item ${item.index + 1}, ${r.method}): message_id ${r.messageId}`);
          results.push({ index: item.index, ok: true, messageId: r.messageId, fileId: r.fileId });
        } catch (e) {
          logger.error('Telegram upload failed:', e);
          jl.error(`❌ Telegram upload failed (item ${item.index + 1} → ${target.label}): ${e.message}`);
          results.push({ index: item.index, ok: false, error: e.message });
        }
      }
    }

    if (ownerJM.saveStore) ownerJM.saveStore();
    res.json({ ok: true, results });
  } catch (e) {
    logger.error(e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
