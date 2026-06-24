'use strict';

// =====================================================================
// Waz / Natok Clipper — Safe Zone + Color Grade + Natok Templates
//
// v2.8 changes:
//   - Custom natok header text / follow text (no hardcoded channel name)
//   - New styles: natok_header_v1, natok_golden, natok_modern
//   - Optional audio ducking with sidechaincompress
//   - Recap concat helper (many ranges => one final video)
// =====================================================================

const FFMPEG_MODULE_VERSION = '2.8.1-natok-isolated-renderer';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ffTime } = require('../utils/timestamp');
const { renderTitlePng } = require('./titleRenderer-natok');

const RUNNING = new Map();
function trackProc(jobId, proc) {
  if (!jobId) return;
  if (!RUNNING.has(jobId)) RUNNING.set(jobId, new Set());
  RUNNING.get(jobId).add(proc);
  proc.on('close', () => {
    const set = RUNNING.get(jobId);
    if (set) {
      set.delete(proc);
      if (!set.size) RUNNING.delete(jobId);
    }
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

// ── Silence Removal ──────────────────────────────────────────────────
// Only for clips < 3 minutes AND no background music.
// Uses silencedetect to find non-silent segments, then concat-trims them.
const SILENCE_NOISE      = -35;   // dB threshold
const SILENCE_DURATION   = 0.4;   // seconds of silence to detect
const SILENCE_MAX_SEC    = 180;   // only apply when clip duration < this

async function removeSilence(inputPath, start, duration, workDir, jobLog, jobId) {
  if (duration >= SILENCE_MAX_SEC) return null; // skip for long clips

  const detectOut = path.join(workDir, `silence_detect_${Date.now()}.txt`);

  // Step 1: detect silence
  await new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'info',
      '-ss', ffTime(Math.max(0, start - 0.05)),
      '-t', ffTime(duration),
      '-i', inputPath,
      '-af', `silencedetect=noise=${SILENCE_NOISE}dB:duration=${SILENCE_DURATION}`,
      '-f', 'null', '-',
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    if (jobId) trackProc(jobId, proc);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', code => {
      fs.writeFileSync(detectOut, stderr);
      resolve();
    });
  });

  // Step 2: parse silence_start / silence_end lines
  const raw = fs.readFileSync(detectOut, 'utf8');
  fs.unlinkSync(detectOut);

  const starts = [];
  const ends   = [];
  for (const line of raw.split('\n')) {
    const ms = line.match(/silence_start:\s*([\d.]+)/);
    const me = line.match(/silence_end:\s*([\d.]+)/);
    if (ms) starts.push(parseFloat(ms[1]));
    if (me) ends.push(parseFloat(me[1]));
  }

  // Build non-silent segments (relative to clip start)
  const segments = [];
  let pos = 0;
  for (let i = 0; i < starts.length; i++) {
    const silStart = starts[i] - (start - 0.05);
    if (silStart > pos + 0.05) segments.push({ from: pos, to: silStart });
    const silEnd = ends[i] !== undefined ? ends[i] - (start - 0.05) : duration;
    pos = Math.min(silEnd, duration);
  }
  if (pos < duration - 0.05) segments.push({ from: pos, to: duration });

  if (!segments.length || segments.length === 1 && segments[0].from < 0.1 && segments[0].to >= duration - 0.1) {
    jobLog.info('silence removal: no significant silence found — skipping');
    return null;
  }

  jobLog.info(`silence removal: ${segments.length} speech segments found (was ${duration.toFixed(1)}s)`);

  // Step 3: trim each segment and concat
  const parts = [];
  const baseStart = Math.max(0, start - 0.05);

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segDur = seg.to - seg.from;
    if (segDur < 0.1) continue;
    const partOut = path.join(workDir, `silence_part_${i}.mp4`);
    const segStart = baseStart + seg.from;

    await new Promise((resolve, reject) => {
      const args = [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-ss', ffTime(segStart),
        '-t', ffTime(segDur),
        '-i', inputPath,
        '-c', 'copy',
        partOut,
      ];
      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      if (jobId) trackProc(jobId, proc);
      proc.on('error', reject);
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`silence trim part ${i} failed`)));
    });
    parts.push(partOut);
  }

  if (!parts.length) return null;

  // Step 4: concat parts
  const concatOut = path.join(workDir, `silence_removed.mp4`);
  const listFile  = path.join(workDir, `silence_concat.txt`);
  fs.writeFileSync(listFile, parts.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));

  await new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0',
      '-i', listFile,
      '-c', 'copy',
      '-movflags', '+faststart',
      concatOut,
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    if (jobId) trackProc(jobId, proc);
    proc.on('error', reject);
    proc.on('close', code => {
      try { fs.unlinkSync(listFile); } catch (_) {}
      for (const p of parts) { try { fs.unlinkSync(p); } catch (_) {} }
      code === 0 ? resolve() : reject(new Error('silence concat failed'));
    });
  });

  jobLog.info(`silence removal done → ${concatOut}`);
  return concatOut; // caller uses this as new input, start=0
}
// ────────────────────────────────────────────────────────────────────

const VIDEO_WIDTH  = parseInt(process.env.VIDEO_WIDTH  || '720', 10);
const VIDEO_HEIGHT = parseInt(process.env.VIDEO_HEIGHT || '1280', 10);
const PRESET  = process.env.FFMPEG_PRESET  || 'ultrafast';
const CRF     = process.env.FFMPEG_CRF     || '24';
const THREADS = process.env.FFMPEG_THREADS || '0';

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIC_PNG    = path.join(PUBLIC_DIR, 'mic.png');

// Safe zones for reels / shorts UI overlays
const SAFE_TOP    = 130;
const SAFE_BOTTOM = 190;

function clamp(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

function shouldShowHeader(styleConfig) {
  return !!(styleConfig && styleConfig.headerBar);
}

async function makeClip({
  input, start, duration, title, speaker,
  titleStyle = 'centered',
  cropMode = 'crop',
  colorGrade = 'none',
  customGradeFilter = '',
  musicFile = null,
  musicVolume = 0.15,
  musicStart = 0,
  musicEnd = 0,
  output, workDir, jobLog, jobId,
  customHeaderText = '',
  followText = 'Follow Us',
  ducking = null,
}) {
  const W = VIDEO_WIDTH;
  const SQ = W;

  const styleConfig  = getStyleConfig(titleStyle, W);

  // 1:1 Square layout — no safe zones, no speaker bar
  const headerHeight = shouldShowHeader(styleConfig) ? (styleConfig.headerHeight || 92) : 0;
  const titleBandH   = Math.max(80, Math.floor(SQ * 0.18));
  const videoSQ      = SQ;
  const H = Math.ceil((headerHeight + titleBandH + videoSQ) / 2) * 2;

  const titleY      = headerHeight;
  const videoY      = headerHeight + titleBandH;
  const speakerBandH = 0;
  const speakerY     = H; // unused — no speaker bar

  fs.mkdirSync(workDir, { recursive: true });

  // ── Silence removal (Shorts only: < 3min, no music) ──────────────
  let effectiveInput = input;
  let effectiveStart = start;
  if (!musicFile && duration < SILENCE_MAX_SEC) {
    try {
      const silRemoved = await removeSilence(input, start, duration, workDir, jobLog, jobId);
      if (silRemoved) {
        effectiveInput = silRemoved;
        effectiveStart = 0;
        jobLog.info(`↳ using silence-removed file: ${path.basename(silRemoved)}`);
      }
    } catch (e) {
      jobLog.warn(`silence removal failed (continuing with original): ${e.message}`);
    }
  } else if (musicFile) {
    jobLog.info('silence removal: skipped (background music ON)');
  }
  // ─────────────────────────────────────────────────────────────────

  // 1) Title PNG
  const titleCanvasW  = styleConfig.titleCanvasW || (W - 40);
  const titleCanvasH  = Math.max(80, titleBandH - 20);
  const titleFontSize = Math.max(32, Math.floor(videoSQ / 13));
  const titlePng      = path.join(workDir, 'title.png');

  renderTitlePng({
    text: title || ' ',
    width: titleCanvasW,
    height: titleCanvasH,
    fontSize: titleFontSize,
    outPath: titlePng,
    fg: styleConfig.titleFg,
    bg: [0, 0, 0, 0],
    shadow: styleConfig.titleShadow,
    fontWeight: 'bold',
    maxCharsPerLine: 22,
  });
  jobLog.info(`✓ title.png rendered: ${titleCanvasW}x${titleCanvasH}`);

  // 2) Speaker PNG
  let speakerPng = null;
  if (speaker && String(speaker).trim()) {
    speakerPng = path.join(workDir, 'speaker.png');
    const spkFs = Math.max(24, Math.floor(videoSQ / 22));
    renderTitlePng({
      text: String(speaker).trim(),
      width: Math.floor(W * 0.7),
      height: Math.floor(speakerBandH * 0.85),
      fontSize: spkFs,
      outPath: speakerPng,
      fg: styleConfig.speakerFg || [255, 255, 255, 255],
      bg: [0, 0, 0, 0],
      shadow: [0, 0, 0, 150, 1, 1],
      fontWeight: 'bold',
      maxCharsPerLine: 30,
    });
    jobLog.info('✓ speaker.png rendered');
  }

  // 3) Optional natok header PNGs
  let headerLeftPng = null;
  let headerRightPng = null;
  if (shouldShowHeader(styleConfig)) {
    const leftText = String(customHeaderText || '').trim() || String(speaker || '').trim() || 'Custom Text';
    const rightText = String(followText || '').trim() || 'Follow Us';

    headerLeftPng = path.join(workDir, 'header_left.png');
    renderTitlePng({
      text: leftText,
      width: Math.floor(W * 0.42),
      height: 72,
      fontSize: 34,
      outPath: headerLeftPng,
      fg: styleConfig.headerLeftFg || [255, 255, 255, 255],
      bg: [0, 0, 0, 0],
      shadow: styleConfig.headerTextShadow || null,
      fontWeight: 'bold',
      maxCharsPerLine: 20,
    });

    headerRightPng = path.join(workDir, 'header_right.png');
    renderTitlePng({
      text: rightText,
      width: Math.floor(W * 0.30),
      height: 72,
      fontSize: 30,
      outPath: headerRightPng,
      fg: styleConfig.headerRightFg || [255, 255, 255, 255],
      bg: [0, 0, 0, 0],
      shadow: styleConfig.headerTextShadow || null,
      fontWeight: 'bold',
      maxCharsPerLine: 18,
    });

    jobLog.info('✓ header text rendered');
  }

  const hasMic = !!speakerPng && fs.existsSync(MIC_PNG);
  const hasMusicFile = !!musicFile && fs.existsSync(musicFile);

  const inputs = ['-ss', ffTime(Math.max(0, effectiveStart - 0.05)), '-i', effectiveInput, '-i', titlePng];
  let idx = 2;
  let titleIdx = 1;
  let headerLeftIdx = null;
  let headerRightIdx = null;
  let speakerIdx = null;
  let micIdx = null;
  let musicIdx = null;

  if (headerLeftPng) {
    inputs.push('-i', headerLeftPng);
    headerLeftIdx = idx++;
  }
  if (headerRightPng) {
    inputs.push('-i', headerRightPng);
    headerRightIdx = idx++;
  }
  if (speakerPng) {
    inputs.push('-i', speakerPng);
    speakerIdx = idx++;
  }
  if (hasMic) {
    inputs.push('-i', MIC_PNG);
    micIdx = idx++;
  }
  if (hasMusicFile) {
    inputs.push('-stream_loop', '-1', '-i', musicFile);
    musicIdx = idx++;
    // If musicStart/musicEnd specified, trim music using atrim in filtergraph
    // (handled later in audio mixing section)
  }

  const videoChain = [];

  if (cropMode === 'crop') {
    videoChain.push(
      `[0:v]crop='min(iw,ih)':'min(iw,ih)':(iw-min(iw\\,ih))/2:(ih-min(iw\\,ih))/2,` +
      `scale=${videoSQ}:${videoSQ}:flags=lanczos,setsar=1[sq]`
    );
  } else {
    videoChain.push(
      `[0:v]scale=${videoSQ}:${videoSQ}:force_original_aspect_ratio=decrease,` +
      `pad=${videoSQ}:${videoSQ}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[sq]`
    );
  }

  const gradedSq = applyColorGrade(videoChain, colorGrade, customGradeFilter);

  // ── Mr Beast style punch zoom (5s cycle: 3s zoom-in 1.00→1.05, 2s zoom-out 1.05→1.00) ──
  const ZOOM_FPS    = 30;
  const ZOOM_CYCLE  = ZOOM_FPS * 5;   // 150 frames = 5s
  const ZOOM_IN_F   = ZOOM_FPS * 3;   // 90 frames = 3s zoom-in
  const ZOOM_MIN    = 1.0;
  const ZOOM_MAX    = 1.05;
  // phase = frame position within the 5s cycle (0..149)
  const zoomExpr =
    `if(lt(mod(on,${ZOOM_CYCLE}),${ZOOM_IN_F}),` +
      `${ZOOM_MIN}+(${ZOOM_MAX}-${ZOOM_MIN})*(mod(on,${ZOOM_CYCLE})/${ZOOM_IN_F}),` +
      `${ZOOM_MAX}-(${ZOOM_MAX}-${ZOOM_MIN})*((mod(on,${ZOOM_CYCLE})-${ZOOM_IN_F})/(${ZOOM_CYCLE}-${ZOOM_IN_F}))` +
    `)`;
  videoChain.push(
    `[${gradedSq}]zoompan=z='${zoomExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
    `d=1:s=${videoSQ}x${videoSQ}:fps=${ZOOM_FPS}[zoomed]`
  );
  const zoomedSq = 'zoomed';
  // ─────────────────────────────────────────────────────────────────────

  const dCeil = Math.max(1, Math.ceil(duration));
  const bgFilter = styleConfig.bgFilter
    ? styleConfig.bgFilter(W, H, dCeil, duration)
    : `color=c=black:s=${W}x${H}:r=30:d=${dCeil},trim=duration=${duration},setpts=PTS-STARTPTS`;

  videoChain.push(`${bgFilter}[bg]`);
  videoChain.push(`[bg][${zoomedSq}]overlay=0:${videoY}[base]`);
  let layer = '[base]';

  // Optional header bar
  if (shouldShowHeader(styleConfig)) {
    const topH = styleConfig.headerHeight || 92;
    videoChain.push(`${layer}drawbox=x=0:y=0:w=${W}:h=${topH}:color=${styleConfig.headerBar}:t=fill[hbg1]`);
    layer = '[hbg1]';
    if (styleConfig.headerUnderline) {
      videoChain.push(`${layer}drawbox=x=0:y=${topH - 3}:w=${W}:h=3:color=${styleConfig.headerUnderline}:t=fill[hbg2]`);
      layer = '[hbg2]';
    }
    if (headerLeftIdx !== null) {
      videoChain.push(`${layer}[${headerLeftIdx}:v]overlay=18:10:format=auto[hl1]`);
      layer = '[hl1]';
    }
    if (headerRightIdx !== null) {
      videoChain.push(`${layer}[${headerRightIdx}:v]overlay=${W - Math.floor(W * 0.30) - 18}:10:format=auto[hl2]`);
      layer = '[hl2]';
    }
  }

  // Title card background
  layer = applyTitleBackground(videoChain, layer, titleStyle, styleConfig, W, titleY, titleBandH);

  // Speaker bar background
  if (speakerPng) {
    videoChain.push(
      `${layer}drawbox=x=0:y=${speakerY}:w=${W}:h=${speakerBandH}:` +
      `color=${styleConfig.speakerBg || '0x111111'}:t=fill[sbg]`
    );
    layer = '[sbg]';
  }

  // Title overlay
  const titleX = Math.floor((W - titleCanvasW) / 2);
  const titlePngY = titleY + Math.floor((titleBandH - titleCanvasH) / 2);
  videoChain.push(`${layer}[${titleIdx}:v]overlay=${titleX}:${titlePngY}:format=auto[lt]`);
  layer = '[lt]';

  // Mic + speaker overlay
  if (speakerPng) {
    const spkFs  = Math.max(24, Math.floor(videoSQ / 22));
    const micH   = Math.floor(spkFs * 1.5);
    const micW   = Math.floor(micH * 0.5);
    const spkCanvasW = Math.floor(W * 0.7);
    const groupW = micW + 14 + spkCanvasW;
    const groupX = Math.floor((W - groupW) / 2);
    const micY   = speakerY + Math.floor((speakerBandH - micH) / 2);

    if (hasMic) {
      videoChain.push(`[${micIdx}:v]scale=-1:${micH}[micscaled]`);
      videoChain.push(`${layer}[micscaled]overlay=${groupX}:${micY}:format=auto[lm]`);
      layer = '[lm]';
    }

    const spkX = hasMic ? (groupX + micW + 14) : Math.floor((W - spkCanvasW) / 2);
    const spkCanvasH = Math.floor(speakerBandH * 0.85);
    const spkY2 = speakerY + Math.floor((speakerBandH - spkCanvasH) / 2);
    videoChain.push(`${layer}[${speakerIdx}:v]overlay=${spkX}:${spkY2}:format=auto[v]`);
  } else {
    videoChain.push(`${layer}null[v]`);
  }

  // Audio mixing / ducking
  // Voice enhancement: highpass removes low-freq bg music rumble,
  // speechnorm + dynaudnorm boost dialogue clarity
  const VOICE_ENHANCE = `highpass=f=180,speechnorm=e=12.5:r=0.0001:l=1,dynaudnorm=f=150:g=15`;

  let audioMap = `0:a?`;
  if (hasMusicFile) {
    // Build music trim filter if start/end specified
    const hasTrim = musicStart > 0 || musicEnd > 0;
    let musicSrc;
    if (hasTrim) {
      const trimEnd = musicEnd > 0 ? `:end=${musicEnd}` : '';
      videoChain.push(`[${musicIdx}:a]atrim=start=${musicStart}${trimEnd},asetpts=PTS-STARTPTS[mraw]`);
      musicSrc = '[mraw]';
    } else {
      musicSrc = `[${musicIdx}:a]`;
    }

    const duck = ducking && ducking.enabled ? {
      enabled: true,
      threshold: clamp(ducking.threshold, 0.001, 1, 0.03),
      ratio: clamp(ducking.ratio, 1, 40, 12),
      attack: clamp(ducking.attack, 1, 5000, 100),
      release: clamp(ducking.release, 1, 5000, 400),
    } : null;

    if (duck) {
      // Fix: asplit voice into two streams — one for sidechain trigger, one for final mix
      // Previously [0:a] was used twice which silently broke ducking in FFmpeg
      videoChain.push(
        `[0:a]${VOICE_ENHANCE},asplit=2[voice1][voice2]`,
        `${musicSrc}volume=${musicVolume}[mbase]`,
        `[mbase][voice1]sidechaincompress=threshold=${duck.threshold}:ratio=${duck.ratio}:release=${duck.release}:attack=${duck.attack}[musicduck]`,
        `[voice2][musicduck]amix=inputs=2:duration=first:dropout_transition=2[aout]`
      );
      audioMap = '[aout]';
    } else {
      videoChain.push(
        `[0:a]${VOICE_ENHANCE}[va]`,
        `${musicSrc}volume=${musicVolume}[ma]`,
        `[va][ma]amix=inputs=2:duration=first:dropout_transition=2[aout]`
      );
      audioMap = '[aout]';
    }
  } else {
    // No external music — still enhance voice clarity
    videoChain.push(`[0:a]${VOICE_ENHANCE}[aout]`);
    audioMap = '[aout]';
  }

  const filterComplex = videoChain.filter(f => f && f.trim()).join(';');

  const args = [
    '-hide_banner', '-loglevel', 'error', '-stats', '-y',
    ...inputs,
    '-filter_complex', filterComplex,
    '-map', '[v]',
    '-map', audioMap,
    '-ss', '0.05',
    '-t', ffTime(duration),
    '-avoid_negative_ts', 'make_zero',
    '-fps_mode', 'cfr',
    '-c:v', 'libx264',
    '-preset', PRESET,
    '-crf', CRF,
    '-pix_fmt', 'yuv420p',
    '-r', '30',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ac', '2',
    '-ar', '44100',
    '-shortest',
    '-movflags', '+faststart',
    '-threads', THREADS,
    '-max_muxing_queue_size', '1024',
    output,
  ];

  jobLog.info(
    `ffmpeg start [v=${FFMPEG_MODULE_VERSION}]: ${path.basename(output)} | ` +
    `style=${titleStyle} | crop=${cropMode} | grade=${colorGrade} | ` +
    `music=${hasMusicFile} | ducking=${!!(ducking && ducking.enabled)} | ${duration.toFixed(1)}s`
  );

  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (jobId) trackProc(jobId, proc);
    let lastErr = '';
    // Timeout: max(300s, duration*8) — kills stuck FFmpeg and rejects
    const timeoutMs = Math.max(300, duration * 8) * 1000;
    const timer = setTimeout(() => {
      jobLog.warn(`⏰ FFmpeg timeout after ${Math.round(timeoutMs/1000)}s — killing stuck process`);
      try { proc.kill('SIGKILL'); } catch (_) {}
      reject(new Error(`ffmpeg timeout after ${Math.round(timeoutMs/1000)}s`));
    }, timeoutMs);
    proc.stdout.on('data', d => d.toString().split(/\r?\n/).forEach(l => l && jobLog.info(`ffmpeg> ${l}`)));
    proc.stderr.on('data', d => {
      const t = d.toString();
      lastErr += t;
      t.split(/\r?\n/).forEach(l => l && jobLog.info(`ffmpeg> ${l.trim()}`));
    });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        jobLog.info(`ffmpeg done: ${path.basename(output)}`);
        resolve(output);
      } else {
        reject(new Error(`ffmpeg exited ${code}: ${lastErr.slice(-500)}`));
      }
    });
  });
}

function concatClips(inputs, output, jobLog, jobId) {
  const listFile = path.join(path.dirname(output), `.concat_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
  const lines = inputs.map(p => `file '${String(p).replace(/'/g, "'\\''")}'`).join(os.EOL);
  fs.writeFileSync(listFile, lines);

  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0',
    '-i', listFile,
    '-c', 'copy',
    '-movflags', '+faststart',
    output,
  ];

  jobLog.info(`ffmpeg concat [${inputs.length} parts] → ${path.basename(output)}`);
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (jobId) trackProc(jobId, proc);
    let lastErr = '';
    proc.stdout.on('data', d => d.toString().split(/\r?\n/).forEach(l => l && jobLog.info(`ffmpeg> ${l}`)));
    proc.stderr.on('data', d => {
      const t = d.toString();
      lastErr += t;
      t.split(/\r?\n/).forEach(l => l && jobLog.info(`ffmpeg> ${l.trim()}`));
    });
    proc.on('error', reject);
    proc.on('close', code => {
      try { fs.unlinkSync(listFile); } catch (_) {}
      if (code === 0) resolve(output);
      else reject(new Error(`ffmpeg concat exited ${code}: ${lastErr.slice(-500)}`));
    });
  });
}

function getStyleConfig(titleStyle, W) {
  const configs = {
    yellow_box: {
      titleFg: [0, 0, 0, 255],
      titleShadow: null,
      titleCanvasW: W - 56,
      speakerBg: '0x111111',
      speakerFg: [255, 255, 255, 255],
    },
    gradient: {
      titleFg: [255, 231, 90, 255],
      titleShadow: [0, 0, 0, 200, 2, 2],
      bgFilter: (W, H, dCeil, dur) =>
        `gradients=size=${W}x${H}:duration=${dCeil}:c0=0x2a0845:c1=0x000000:x0=${Math.floor(W / 2)}:y0=0:x1=${Math.floor(W / 2)}:y1=${H}:r=30,trim=duration=${dur},setpts=PTS-STARTPTS`,
      speakerBg: '0x1a0530',
      speakerFg: [255, 255, 255, 255],
    },
    centered: {
      titleFg: [255, 255, 255, 255],
      titleShadow: [0, 0, 0, 200, 2, 2],
      speakerBg: '0x111111',
      speakerFg: [255, 255, 255, 255],
    },
    natok_emotional: {
      titleFg: [80, 0, 120, 255],
      titleShadow: null,
      titleCanvasW: W - 40,
      bgFilter: (W, H, dCeil, dur) =>
        `color=c=0x1a0a2e:s=${W}x${H}:r=30:d=${dCeil},trim=duration=${dur},setpts=PTS-STARTPTS`,
      speakerBg: '0x2d1b4e',
      speakerFg: [255, 255, 255, 255],
    },
    natok_dark: {
      titleFg: [255, 255, 255, 255],
      titleShadow: [0, 200, 255, 180, 2, 2],
      bgFilter: (W, H, dCeil, dur) =>
        `gradients=size=${W}x${H}:duration=${dCeil}:c0=0x0a1628:c1=0x000000:x0=${Math.floor(W / 2)}:y0=0:x1=${Math.floor(W / 2)}:y1=${H}:r=30,trim=duration=${dur},setpts=PTS-STARTPTS`,
      speakerBg: '0x0a1628',
      speakerFg: [100, 220, 255, 255],
    },
    natok_minimal: {
      titleFg: [255, 255, 255, 255],
      titleShadow: [0, 0, 0, 180, 1, 1],
      speakerBg: '0x0d0d0d',
      speakerFg: [200, 200, 200, 255],
    },
    natok_warm: {
      titleFg: [255, 240, 200, 255],
      titleShadow: [100, 0, 0, 200, 2, 2],
      bgFilter: (W, H, dCeil, dur) =>
        `gradients=size=${W}x${H}:duration=${dCeil}:c0=0x3d0c0c:c1=0x1a0505:x0=${Math.floor(W / 2)}:y0=0:x1=${Math.floor(W / 2)}:y1=${H}:r=30,trim=duration=${dur},setpts=PTS-STARTPTS`,
      speakerBg: '0x2a0808',
      speakerFg: [255, 200, 150, 255],
    },
    natok_header_v1: {
      titleFg: [60, 60, 60, 255],
      titleShadow: null,
      titleCanvasW: W - 60,
      bgFilter: (W, H, dCeil, dur) =>
        `color=c=0x000000:s=${W}x${H}:r=30:d=${dCeil},trim=duration=${dur},setpts=PTS-STARTPTS`,
      speakerBg: '0x1f1f1f',
      speakerFg: [240, 240, 240, 255],
      headerBar: '0x99008c',
      headerUnderline: '0xffffff',
      headerLeftFg: [255, 255, 255, 255],
      headerRightFg: [255, 255, 255, 255],
      headerTextShadow: [0, 0, 0, 120, 1, 1],
      headerHeight: 92,
    },
    natok_golden: {
      titleFg: [255, 244, 210, 255],
      titleShadow: [0, 0, 0, 180, 2, 2],
      titleCanvasW: W - 70,
      bgFilter: (W, H, dCeil, dur) =>
        `gradients=size=${W}x${H}:duration=${dCeil}:c0=0x1a1030:c1=0x0b0618:x0=0:y0=0:x1=${W}:y1=${H}:r=30,trim=duration=${dur},setpts=PTS-STARTPTS`,
      speakerBg: '0x1b1325',
      speakerFg: [245, 229, 179, 255],
      headerBar: '0xC9A64B',
      headerUnderline: '0x3c2b07',
      headerLeftFg: [15, 12, 4, 255],
      headerRightFg: [15, 12, 4, 255],
      headerTextShadow: null,
      headerHeight: 96,
    },
    natok_modern: {
      titleFg: [255, 255, 255, 255],
      titleShadow: [0, 0, 0, 170, 2, 2],
      titleCanvasW: W - 70,
      bgFilter: (W, H, dCeil, dur) =>
        `gradients=size=${W}x${H}:duration=${dCeil}:c0=0x0f1326:c1=0x05070d:x0=0:y0=0:x1=${W}:y1=${H}:r=30,trim=duration=${dur},setpts=PTS-STARTPTS`,
      speakerBg: '0x151826',
      speakerFg: [225, 225, 225, 255],
      headerBar: '0x24273a',
      headerUnderline: '0xff3ea5',
      headerLeftFg: [255, 255, 255, 255],
      headerRightFg: [255, 255, 255, 255],
      headerTextShadow: [0, 0, 0, 160, 1, 1],
      headerHeight: 88,
    },
    natok_purple: {
      titleFg: [26, 26, 26, 255],
      titleShadow: null,
      titleCanvasW: W - 60,
      bgFilter: (W, H, dCeil, dur) =>
        `color=c=0xf3e6ff:s=${W}x${H}:r=30:d=${dCeil},trim=duration=${dur},setpts=PTS-STARTPTS`,
      speakerBg: '0x7B2D8B',
      speakerFg: [255, 255, 255, 255],
      headerBar: '0x7B2D8B',
      headerLeftFg: [255, 255, 255, 255],
      headerRightFg: [255, 255, 255, 255],
      headerTextShadow: null,
      headerHeight: 90,
    },
    natok_gold2: {
      titleFg: [255, 255, 255, 255],
      titleShadow: [0, 0, 0, 200, 2, 2],
      titleCanvasW: W - 60,
      bgFilter: (W, H, dCeil, dur) =>
        `color=c=0x0a0a0a:s=${W}x${H}:r=30:d=${dCeil},trim=duration=${dur},setpts=PTS-STARTPTS`,
      speakerBg: '0xf0c040',
      speakerFg: [17, 17, 17, 255],
      headerBar: '0xf0c040',
      headerLeftFg: [17, 17, 17, 255],
      headerRightFg: [17, 17, 17, 255],
      headerTextShadow: null,
      headerHeight: 88,
    },
    natok_green: {
      titleFg: [255, 255, 255, 255],
      titleShadow: [0, 0, 0, 180, 1, 1],
      titleCanvasW: W - 60,
      bgFilter: (W, H, dCeil, dur) =>
        `color=c=0x0d3d22:s=${W}x${H}:r=30:d=${dCeil},trim=duration=${dur},setpts=PTS-STARTPTS`,
      speakerBg: '0x061a0e',
      speakerFg: [180, 240, 200, 255],
      headerBar: '0x000000@0.5',
      headerUnderline: '0x4caf80',
      headerLeftFg: [255, 255, 255, 255],
      headerRightFg: [200, 240, 215, 255],
      headerTextShadow: [0, 0, 0, 160, 1, 1],
      headerHeight: 88,
    },
  };
  return configs[titleStyle] || configs.centered;
}

function applyTitleBackground(videoChain, layer, titleStyle, styleConfig, W, titleY, titleBandH) {
  if (titleStyle === 'yellow_box') {
    const bm = 24, by2 = titleY + 12;
    const bw = W - 2 * bm, bh = titleBandH - 24;
    videoChain.push(`${layer}drawbox=x=${bm - 3}:y=${by2 - 3}:w=${bw + 6}:h=${bh + 6}:color=black:t=fill[bb1]`);
    videoChain.push(`[bb1]drawbox=x=${bm}:y=${by2}:w=${bw}:h=${bh}:color=0xFFD700:t=fill[bb2]`);
    return '[bb2]';
  }
  if (titleStyle === 'natok_emotional' || titleStyle === 'natok_header_v1') {
    const bm = 20, by2 = titleY + 8;
    const bw = W - 2 * bm, bh = titleBandH - 16;
    videoChain.push(`${layer}drawbox=x=${bm - 4}:y=${by2 - 4}:w=${bw + 8}:h=${bh + 8}:color=0x6600aa:t=fill[nb1]`);
    videoChain.push(`[nb1]drawbox=x=${bm}:y=${by2}:w=${bw}:h=${bh}:color=white:t=fill[nb2]`);
    return '[nb2]';
  }
  if (titleStyle === 'natok_dark' || titleStyle === 'natok_modern') {
    const bm = 16, by2 = titleY + 8;
    const bw = W - 2 * bm, bh = titleBandH - 16;
    videoChain.push(`${layer}drawbox=x=${bm}:y=${by2}:w=${bw}:h=${bh}:color=0x001a33@0.85:t=fill[nb1]`);
    videoChain.push(`[nb1]drawbox=x=${bm}:y=${by2}:w=${bw}:h=3:color=0x00ccff:t=fill[nb2]`);
    videoChain.push(`[nb2]drawbox=x=${bm}:y=${by2 + bh - 3}:w=${bw}:h=3:color=0xff3ea5:t=fill[nb3]`);
    return '[nb3]';
  }
  if (titleStyle === 'natok_warm') {
    const bm = 16, by2 = titleY + 8;
    const bw = W - 2 * bm, bh = titleBandH - 16;
    videoChain.push(`${layer}drawbox=x=${bm}:y=${by2}:w=${bw}:h=${bh}:color=0x8b0000@0.75:t=fill[nw1]`);
    return '[nw1]';
  }
  if (titleStyle === 'natok_golden') {
    const bm = 18, by2 = titleY + 8;
    const bw = W - 2 * bm, bh = titleBandH - 16;
    videoChain.push(`${layer}drawbox=x=${bm - 4}:y=${by2 - 4}:w=${bw + 8}:h=${bh + 8}:color=0xC9A64B:t=fill[ng1]`);
    videoChain.push(`[ng1]drawbox=x=${bm}:y=${by2}:w=${bw}:h=${bh}:color=0x101010@0.92:t=fill[ng2]`);
    return '[ng2]';
  }
  if (titleStyle === 'natok_purple') {
    videoChain.push(`${layer}drawbox=x=0:y=${titleY}:w=${W}:h=${titleBandH}:color=white@0.97:t=fill[np1]`);
    videoChain.push(`[np1]drawbox=x=0:y=${titleY + titleBandH - 6}:w=${W}:h=6:color=0x7B2D8B:t=fill[np2]`);
    return '[np2]';
  }
  if (titleStyle === 'natok_gold2') {
    videoChain.push(`${layer}drawbox=x=0:y=${titleY}:w=${W}:h=${titleBandH}:color=0x0a0a0a@0.92:t=fill[ng2a]`);
    videoChain.push(`[ng2a]drawbox=x=0:y=${titleY + titleBandH - 6}:w=${W}:h=6:color=0xf0c040:t=fill[ng2b]`);
    return '[ng2b]';
  }
  if (titleStyle === 'natok_green') {
    videoChain.push(`${layer}drawbox=x=0:y=${titleY}:w=${W}:h=${titleBandH}:color=0x000000@0.55:t=fill[ngr1]`);
    videoChain.push(`[ngr1]drawbox=x=0:y=${titleY + titleBandH - 6}:w=${W}:h=6:color=0x4caf80:t=fill[ngr2]`);
    return '[ngr2]';
  }
  return layer;
}

function applyColorGrade(videoChain, grade, customFilter = '') {
  if (!grade || grade === 'none') {
    videoChain.push('[sq]null[graded]');
    return 'graded';
  }

  let filter = '';
  if (grade === 'custom') {
    filter = (customFilter || '').trim() || 'eq=saturation=1.0';
  } else if (grade === 'warm') {
    filter = `eq=saturation=1.3:contrast=1.22:brightness=-0.05:gamma_r=1.08:gamma_b=0.88,colorlevels=romin=0.04:gomin=0.02:bomin=0.0:rimax=0.96:gimax=0.94:bimax=0.88`;
  } else if (grade === 'cool') {
    filter = `eq=saturation=0.65:contrast=1.08:brightness=0.04:gamma_r=0.88:gamma_b=1.18,colorlevels=romin=0.0:gomin=0.04:bomin=0.12:rimax=0.88:gimax=0.92:bimax=1.0`;
  } else if (grade === 'cinema') {
    filter = `eq=saturation=0.82:contrast=1.18:brightness=-0.04:gamma=0.92`;
  } else if (grade === 'vivid') {
    filter = `eq=saturation=1.55:contrast=1.12:brightness=0.015`;
  } else {
    videoChain.push('[sq]null[graded]');
    return 'graded';
  }

  videoChain.push(`[sq]${filter}[graded]`);
  return 'graded';
}

module.exports = { makeClip, concatClips, FFMPEG_MODULE_VERSION, killJob };
