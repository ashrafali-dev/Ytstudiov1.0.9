'use strict';

// =====================================================================
// YT Studio — Telegram upload service
//
// Two upload paths, picked automatically by file size + what's configured:
//
//  1. HTTP Bot API (https://api.telegram.org/bot<token>/sendVideo) — used
//     for files <= 50MB. Simple, fast, no extra dependency. This is also
//     the fallback for bigger files if MTProto isn't configured.
//
//  2. MTProto (GramJS) — used for files > 50MB when TELEGRAM_API_ID +
//     TELEGRAM_API_HASH are configured (Config tab). This talks to
//     Telegram's MTProto backend directly from THIS process — no separate
//     server/service needed — and supports uploads up to ~2000MB, because
//     MTProto's native chunked upload isn't subject to the HTTP Bot API's
//     50MB multipart cap (that cap only applies to the api.telegram.org
//     HTTP gateway, not to MTProto itself).
//
// Both paths return the same shape: { messageId, fileId, method }.
//
// IMPORTANT (memory-safety, HTTP path only): we deliberately do NOT use
// fetch()+FormData for the HTTP path. Node's built-in fetch (undici) is
// known to buffer the entire request body in memory for FormData/Blob
// bodies in some cases (https://github.com/nodejs/undici/issues/4058) —
// the same class of Railway OOM bug already hit (and fixed) elsewhere in
// this project for full-video buffering. Instead we hand-build the
// multipart/form-data envelope and pipe fs.createReadStream() straight
// into the http(s) request socket, so memory use stays flat regardless
// of file size. GramJS's sendFile() streams from disk internally too.
// =====================================================================

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { logger } = require('../utils/logger');

const CONFIG_FILE = process.env.CONFIG_FILE || '/app/data/config.json';

// Telegram's standard public Bot API caps file uploads at 50MB no matter
// the method (sendVideo/sendDocument/sendAudio all share this cap). Above
// this, we switch to MTProto (if TELEGRAM_API_ID/HASH are set) or fall
// back to sendDocument over HTTP (which will still likely fail >50MB).
const SIZE_LIMIT_FOR_VIDEO = 50 * 1024 * 1024; // 50MB

// NOTE: deliberately NOT a module-level constant. It must be read fresh on
// every call so that saving it via the Config tab (which sets process.env
// at request-time, no restart) takes effect immediately — same reason
// TELEGRAM_BOT_TOKEN below is read inside each upload function rather
// than cached.
function getApiBaseUrl() {
  return (process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org').replace(/\/+$/, '');
}

// 3 preset channels — ONE bot token (TELEGRAM_BOT_TOKEN) shared across all
// of them; each channel's own chat_id lives in its own env var.
const CHANNELS = [
  { key: 'waz',   label: 'Waz Channel',    chatIdEnv: 'TELEGRAM_CHAT_ID_WAZ' },
  { key: 'natok', label: 'নাটক Channel',   chatIdEnv: 'TELEGRAM_CHAT_ID_NATOK' },
  { key: 'bulk',  label: 'Bulk Channel',   chatIdEnv: 'TELEGRAM_CHAT_ID_BULK' },
];

function resolveChannel(key) {
  const ch = CHANNELS.find(c => c.key === key);
  if (!ch) return null;
  return { ...ch, chatId: process.env[ch.chatIdEnv] || null };
}

function listChannels() {
  return CHANNELS.map(c => ({ key: c.key, label: c.label, configured: !!process.env[c.chatIdEnv] }));
}

// ---------- tiny config.json read/write (just for the MTProto session) ----------
// This intentionally does NOT go through routes/setup.js's ALLOWED_CONFIG_KEYS —
// the session string is auto-generated, not something the user types in, so it
// doesn't belong in that user-facing allowlist. We just read/merge/write the
// same file setup.js uses, so it survives restarts alongside the other secrets.
function readConfigFile() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) { logger.warn('telegram: config.json read failed:', e.message); }
  return {};
}
function saveSessionToConfig(sessionStr) {
  try {
    const cfg = readConfigFile();
    if (cfg.TELEGRAM_MTPROTO_SESSION === sessionStr) return; // no change, skip write
    cfg.TELEGRAM_MTPROTO_SESSION = sessionStr;
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch (e) { logger.error('telegram: session save failed:', e.message); }
}

function buildBoundary() {
  return '----YTStudioTelegram' + Date.now().toString(16) + Math.random().toString(16).slice(2);
}

// ---------- Path 1: plain HTTP Bot API (files <= 50MB, or MTProto not configured) ----------
function uploadFileViaHttp(chatId, filePath, caption, size) {
  return new Promise((resolve, reject) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return reject(new Error('TELEGRAM_BOT_TOKEN env var সেট করা নেই'));

    const asDocument = size > SIZE_LIMIT_FOR_VIDEO;
    const method      = asDocument ? 'sendDocument' : 'sendVideo';
    const fileField    = asDocument ? 'document' : 'video';
    const fileName     = path.basename(filePath);
    const boundary      = buildBoundary();

    const fields = [['chat_id', String(chatId)]];
    if (caption) fields.push(['caption', String(caption).slice(0, 1024)]); // Telegram caption limit

    let pre = '';
    for (const [name, value] of fields) {
      pre += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    }
    pre += `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: video/mp4\r\n\r\n`;

    const preBuf  = Buffer.from(pre, 'utf8');
    const postBuf = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');

    let url;
    const apiBaseUrl = getApiBaseUrl();
    try { url = new URL(`${apiBaseUrl}/bot${token}/${method}`); } catch (e) { return reject(e); }
    const transport = url.protocol === 'http:' ? http : https;

    const req = transport.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': preBuf.length + size + postBuf.length,
      },
    });

    req.on('error', reject);
    req.on('response', (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let data = {};
        try { data = JSON.parse(body); } catch (_) {}

        if (res.statusCode >= 200 && res.statusCode < 300 && data.ok) {
          const result    = data.result || {};
          const sentFile  = result.video || result.document || {};
          logger.info(`Uploaded to Telegram (${method}): ${fileName} (message_id ${result.message_id})`);
          resolve({ messageId: result.message_id, fileId: sentFile.file_id || null, method });
        } else {
          const desc = (data && data.description) || `HTTP ${res.statusCode}`;
          const hint = asDocument
            ? ' (50MB+ ফাইল সরাসরি video হিসেবে পাঠাতে চাইলে Config tab-এ TELEGRAM_API_ID/TELEGRAM_API_HASH সেট করো)'
            : '';
          reject(new Error(desc + hint));
        }
      });
    });

    // Stream the file straight into the request socket — never buffer the
    // whole thing in memory, regardless of file size.
    req.write(preBuf);
    const fileStream = fs.createReadStream(filePath);
    fileStream.on('error', (e) => { req.destroy(); reject(e); });
    fileStream.pipe(req, { end: false });
    fileStream.on('end', () => { req.end(postBuf); });
  });
}

// ---------- Path 2: MTProto via GramJS (files > 50MB, real video, no separate service) ----------
let mtprotoClient = null;
let mtprotoConnecting = null;
let mtprotoClientFingerprint = null; // apiId+apiHash+botToken the cached client was built with

async function getMtprotoClient() {
  const apiId   = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
  const apiHash = process.env.TELEGRAM_API_HASH || '';
  const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
  if (!apiId)   throw new Error('TELEGRAM_API_ID সেট করা নেই (Config tab)');
  if (!apiHash) throw new Error('TELEGRAM_API_HASH সেট করা নেই (Config tab)');
  if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN সেট করা নেই (Config tab)');

  const fingerprint = `${apiId}:${apiHash}:${botToken}`;

  // If creds changed via the Config tab since the cached client was built
  // (no restart needed for that to take effect — same reason as the
  // API_BASE_URL fix above), drop the stale client and reconnect fresh.
  if (mtprotoClient && mtprotoClientFingerprint !== fingerprint) {
    try { mtprotoClient.disconnect(); } catch (_) {}
    mtprotoClient = null;
    mtprotoClientFingerprint = null;
  }

  if (mtprotoClient && mtprotoClient.connected) return mtprotoClient;

  // Only one connection attempt at a time — concurrent uploads share it.
  if (!mtprotoConnecting) {
    mtprotoConnecting = (async () => {
      // Lazy require — keeps the (sizeable) GramJS module out of memory
      // entirely for installs that never upload anything >50MB.
      const { TelegramClient } = require('telegram');
      const { StringSession } = require('telegram/sessions');

      const cfg = readConfigFile();
      const session = new StringSession(cfg.TELEGRAM_MTPROTO_SESSION || '');
      const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 3 });

      // Hard timeout so an unreachable/misconfigured setup fails fast with
      // a clear error instead of hanging the upload request indefinitely.
      await Promise.race([
        client.start({ botAuthToken: botToken }),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('Telegram MTProto সার্ভারে কানেক্ট করতে পারলাম না (৩০ সেকেন্ড টাইমআউট) — API_ID/API_HASH ঠিক আছে কিনা চেক করো, বা Railway-এর network outbound block করা থাকলে সেটাও দেখো')),
          30000,
        )),
      ]);

      const saved = client.session.save();
      if (saved) saveSessionToConfig(saved);

      logger.info('✓ Telegram MTProto client connected (large-file uploads enabled)');
      mtprotoClient = client;
      mtprotoClientFingerprint = fingerprint;
      return client;
    })();
  }

  try {
    return await mtprotoConnecting;
  } finally {
    mtprotoConnecting = null;
  }
}

async function uploadFileViaMtproto(chatId, filePath, caption) {
  const client = await getMtprotoClient();
  const msg = await client.sendFile(chatId, {
    file: filePath,
    caption: caption ? String(caption).slice(0, 1024) : undefined,
    supportsStreaming: true,
    workers: 4,
  });

  let fileId = null;
  try {
    const doc = msg.media && (msg.media.document || (msg.media.video && msg.media.video.document));
    if (doc && doc.id) fileId = String(doc.id);
  } catch (_) {}

  logger.info(`Uploaded to Telegram (mtprotoSendFile): ${path.basename(filePath)} (message_id ${msg.id})`);
  return { messageId: msg.id, fileId, method: 'mtprotoSendFile' };
}

// ---------- Dispatcher ----------
/**
 * Upload a local file to a Telegram chat.
 *  - chatId   → destination chat/channel id (from the preset's env var)
 *  - filePath → absolute path to the file on disk (OUTPUT_DIR/<filename>)
 *  - caption  → caption shown under the video/document (acts like Drive's displayName)
 *
 * Files <= 50MB always go through the simple HTTP Bot API (sendVideo).
 * Files > 50MB go through MTProto (real video, up to ~2000MB) if
 * TELEGRAM_API_ID/TELEGRAM_API_HASH are configured; otherwise they fall
 * back to sendDocument over HTTP (will likely be rejected by Telegram —
 * see the hint in the resulting error).
 */
async function uploadFile(chatId, filePath, caption) {
  if (!chatId) throw new Error('chat_id missing — channel env var চেক করো');
  if (!fs.existsSync(filePath)) throw new Error('file missing on disk');

  const size = fs.statSync(filePath).size;
  const apiId   = process.env.TELEGRAM_API_ID;
  const apiHash = process.env.TELEGRAM_API_HASH;

  if (size > SIZE_LIMIT_FOR_VIDEO && apiId && apiHash) {
    return uploadFileViaMtproto(chatId, filePath, caption);
  }
  return uploadFileViaHttp(chatId, filePath, caption, size);
}

module.exports = { uploadFile, resolveChannel, listChannels, CHANNELS };
