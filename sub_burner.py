#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Sub Burner Worker  —  called by Node.js as a subprocess.
Reads job config from --config <path>.json
Outputs JSON lines to stdout for progress/log streaming.
"""

import argparse
import json
import math
import os
import re
import subprocess
import sys
import time
import tempfile
import traceback
import urllib.request
import urllib.parse
from pathlib import Path

# ── stdout JSON emitters ───────────────────────────────────────────────────────

def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)

def log(level, msg):
    emit({'type': 'log', 'level': level, 'msg': str(msg)})

def info(msg):     log('info',  msg)
def warn(msg):     log('warn',  msg)
def err(msg):      log('error', msg)

def progress(pct, stage=''):
    emit({'type': 'progress', 'pct': int(pct), 'stage': stage})

# ── font / style data ──────────────────────────────────────────────────────────

FONTS_DIR = Path('/tmp/subburner_fonts')
FONTS_DIR.mkdir(parents=True, exist_ok=True)

FONTS = {
    '1': {
        'name': 'SolaimanLipi', 'family': 'SolaimanLipi',
        'file': 'SolaimanLipi.ttf',
        'url':  'https://raw.githubusercontent.com/shiftenterdev/bangla-font/master/SolaimanLipi.ttf',
    },
    '2': {
        'name': 'Kalpurush', 'family': 'Kalpurush',
        'file': 'kalpurush.ttf',
        'url':  'https://raw.githubusercontent.com/hmoazzem/bangla-fonts/master/kalpurush.ttf',
    },
    '3': {
        'name': 'Hind Siliguri', 'family': 'Hind Siliguri',
        'file': 'HindSiliguri-Regular.ttf',
        'url':  'https://github.com/google/fonts/raw/main/ofl/hindsiliguri/HindSiliguri-Regular.ttf',
    },
}

COLORS    = {'1': ('White','&H00FFFFFF'), '2': ('Warm White','&H00F2F7FF'),
             '3': ('Netflix Yellow','&H0000F8FF'), '4': ('Cyan','&H00FFFF00')}
POSITIONS = {'1': ('Bottom', 2), '2': ('Middle', 5), '3': ('Top', 8)}
SIZES     = {'1': ('Normal', 0.060), '2': ('Large', 0.072),
             '3': ('XL', 0.084), '4': ('XXL', 0.096)}

STYLE_PRESETS = {
    '1': {
        'name': 'Screenshot Boxed',
        'font_key': '1', 'color_key': '1', 'position_key': '1', 'size_key': '1',
        'bold': True, 'italic': False, 'border_style': 3, 'outline': 1, 'shadow': 0,
        'back_colour': '&H50000000', 'outline_colour': '&H00000000',
        'spacing': 0, 'margin_lr_ratio': 0.05, 'margin_v_ratio': 0.04, 'blur': 0,
        'size_ratio_916': 0.038, 'margin_lr_ratio_916': 0.04, 'margin_v_ratio_916': 0.06,
        'crop_169_font_size': 56,
        'crop_169_margin_offset': 120,
    },
    '2': {
        'name': 'Netflix Clean',
        'font_key': '1', 'color_key': '1', 'position_key': '1', 'size_key': '1',
        'bold': True, 'italic': False, 'border_style': 1, 'outline': 2.5, 'shadow': 1.0,
        'back_colour': '&H00000000', 'outline_colour': '&H00000000',
        'spacing': 0, 'margin_lr_ratio': 0.05, 'margin_v_ratio': 0.04, 'blur': 0,
        'size_ratio_916': 0.038, 'margin_lr_ratio_916': 0.04, 'margin_v_ratio_916': 0.06,
        'crop_169_font_size': 52,
        'crop_169_margin_offset': 120,
    },
    '3': {
        'name': 'Big Mobile Box',
        'font_key': '1', 'color_key': '1', 'position_key': '1', 'size_key': '2',
        'bold': True, 'italic': False, 'border_style': 3, 'outline': 1, 'shadow': 0,
        'back_colour': '&H60000000', 'outline_colour': '&H00000000',
        'spacing': 0, 'margin_lr_ratio': 0.05, 'margin_v_ratio': 0.04, 'blur': 0,
        'size_ratio_916': 0.042, 'margin_lr_ratio_916': 0.04, 'margin_v_ratio_916': 0.06,
        'crop_169_font_size': 52,
        'crop_169_margin_offset': 130,
    },
}

# ── Color grading filter builder ───────────────────────────────────────────────

def build_color_grade_filter(grade):
    """Return an ffmpeg vf filter string for color grading, or '' for none/natural."""
    grade = (grade or 'natural').lower()
    if grade in ('none', 'natural', ''):
        return ''
    if grade == 'bright':
        # Slightly brighten + increase saturation
        return 'eq=brightness=0.06:saturation=1.15:contrast=1.05'
    if grade == 'vivid':
        # High saturation, slight brightness
        return 'eq=brightness=0.04:saturation=1.4:contrast=1.08'
    if grade == 'warm':
        # Warm tones: boost red/green, reduce blue slightly via curves
        return 'curves=r=0/0 0.5/0.58 1/1:g=0/0 0.5/0.52 1/1:b=0/0 0.5/0.44 1/1'
    if grade == 'cinema':
        # Cinematic: slight desaturation, lift shadows, lower highlights
        return 'eq=saturation=0.85:contrast=1.12:brightness=-0.02,curves=r=0/0.05 1/0.95:g=0/0.05 1/0.95:b=0/0.08 1/0.92'
    return ''

# ── Subtitle position helper ──────────────────────────────────────────────────

def sub_pos_to_align(sub_pos):
    """Convert top/middle/bottom to ASS alignment number."""
    mapping = {'top': 8, 'middle': 5, 'bottom': 2}
    return mapping.get((sub_pos or 'bottom').lower(), 2)

# ── BGM download helper ────────────────────────────────────────────────────────

def fetch_bgm(bgm_cfg, output_dir):
    """
    Download BGM from YouTube URL using yt-dlp, trim to [start, end], normalize volume.
    Returns path to processed audio file, or None on failure.
    bgm_cfg = {url, start, end, volume}
    """
    if not bgm_cfg or not bgm_cfg.get('url'):
        return None

    url    = bgm_cfg['url']
    start  = bgm_cfg.get('start', '')   # HH:MM:SS or ''
    end    = bgm_cfg.get('end', '')     # HH:MM:SS or ''
    volume = float(bgm_cfg.get('volume', 30)) / 100.0  # 0.0–1.0

    raw_path    = os.path.join(output_dir, 'bgm_raw.%(ext)s')
    raw_out     = os.path.join(output_dir, 'bgm_raw.mp3')
    trimmed_out = os.path.join(output_dir, 'bgm_trimmed.mp3')

    info(f'BGM: downloading from {url[:60]} …')
    dl_cmd = [
        'yt-dlp', '-x', '--audio-format', 'mp3',
        '--audio-quality', '5',
        '-o', raw_path,
        '--no-playlist',
        url
    ]
    rc = subprocess.run(dl_cmd, capture_output=True, timeout=180).returncode
    if rc != 0 or not Path(raw_out).exists():
        # Try alternate output name (yt-dlp may use different ext)
        candidates = list(Path(output_dir).glob('bgm_raw.*'))
        if candidates:
            raw_out = str(candidates[0])
        else:
            warn('BGM download failed — skipping background music')
            return None

    info(f'BGM downloaded: {os.path.basename(raw_out)}')

    # Build trim + volume filter
    trim_args = []
    if start:
        trim_args += ['-ss', start]
    if end:
        trim_args += ['-to', end]

    af = f'volume={volume:.3f}'

    trim_cmd = [
        'ffmpeg', '-y',
        '-i', raw_out,
        *trim_args,
        '-af', af,
        '-c:a', 'libmp3lame', '-b:a', '128k',
        trimmed_out
    ]
    rc = subprocess.run(trim_cmd, capture_output=True, timeout=120).returncode
    if rc != 0 or not Path(trimmed_out).exists():
        warn('BGM trim/volume failed — using raw download')
        return raw_out

    info(f'BGM ready: {os.path.basename(trimmed_out)} vol={int(volume*100)}%')
    return trimmed_out

# ── Drive upload helper ────────────────────────────────────────────────────────

def upload_to_drive(file_path, drive_folder_url):
    """
    Upload file to Google Drive folder using rclone or gdrive CLI if available.
    Falls back to a simple Drive API upload via service account credentials.
    Returns (success: bool, drive_url: str|None)
    """
    if not drive_folder_url or not drive_folder_url.strip():
        return False, None
    if not Path(file_path).exists():
        warn(f'Drive upload: file not found: {file_path}')
        return False, None

    # Extract folder ID from URL
    m = re.search(r'/folders/([a-zA-Z0-9_-]+)', drive_folder_url)
    if not m:
        warn(f'Drive upload: cannot parse folder ID from: {drive_folder_url}')
        return False, None
    folder_id = m.group(1)

    # Try rclone first (if configured)
    rclone_result = _drive_upload_rclone(file_path, folder_id)
    if rclone_result is not None:
        return True, rclone_result

    # Try gdrive CLI (if available)
    gdrive_result = _drive_upload_gdrive(file_path, folder_id)
    if gdrive_result is not None:
        return True, gdrive_result

    warn('Drive upload: neither rclone nor gdrive CLI available — skipping Drive upload')
    return False, None

def _drive_upload_rclone(file_path, folder_id):
    """Try rclone upload. Returns drive URL string or None."""
    try:
        result = subprocess.run(['which', 'rclone'], capture_output=True, timeout=5)
        if result.returncode != 0:
            return None
    except Exception:
        return None
    try:
        dest = f'drive:{folder_id}/{os.path.basename(file_path)}'
        rc = subprocess.run(
            ['rclone', 'copy', file_path, f'drive:{folder_id}', '--drive-use-trash=false'],
            capture_output=True, timeout=600
        ).returncode
        if rc == 0:
            info(f'rclone Drive upload OK → folder {folder_id}')
            return f'https://drive.google.com/drive/folders/{folder_id}'
        return None
    except Exception as e:
        warn(f'rclone upload error: {e}')
        return None

def _drive_upload_gdrive(file_path, folder_id):
    """Try gdrive CLI upload. Returns drive URL string or None."""
    try:
        result = subprocess.run(['which', 'gdrive'], capture_output=True, timeout=5)
        if result.returncode != 0:
            return None
    except Exception:
        return None
    try:
        r = subprocess.run(
            ['gdrive', 'files', 'upload', '--parent', folder_id, file_path],
            capture_output=True, text=True, timeout=600
        )
        if r.returncode == 0:
            info(f'gdrive upload OK → folder {folder_id}')
            return f'https://drive.google.com/drive/folders/{folder_id}'
        return None
    except Exception as e:
        warn(f'gdrive upload error: {e}')
        return None

# ── utilities ─────────────────────────────────────────────────────────────────

def download_bytes(url, timeout=60):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

def ensure_font(font_key):
    meta = FONTS.get(font_key, FONTS['1'])
    path = FONTS_DIR / meta['file']
    if path.exists() and path.stat().st_size > 10000:
        info(f'Font ready: {meta["name"]}')
        return str(path)
    info(f'Downloading font: {meta["name"]} …')
    try:
        data = download_bytes(meta['url'], timeout=60)
        path.write_bytes(data)
        if path.stat().st_size <= 10000:
            raise RuntimeError('font too small after download')
        info(f'Font saved: {path}')
        return str(path)
    except Exception as e:
        warn(f'Font download failed: {e} — will fall back to system font')
        return ''

def esc_filter(p):
    return p.replace('\\', '\\\\').replace(':', '\\:').replace("'", "\\'").replace(',', '\\,')

def fmt_time(sec):
    if sec is None: return '?'
    sec = int(sec); h = sec // 3600; m = (sec % 3600) // 60; s = sec % 60
    if h: return f'{h}h {m}m {s}s'
    if m: return f'{m}m {s}s'
    return f'{s}s'

def strip_html_tags(text):
    return re.sub(r'<[^>]+>', '', text)

def to_ass_time(ts):
    ts = ts.strip().replace(',', '.')
    if re.fullmatch(r'\d+:\d+:\d+(?:\.\d+)?', ts):
        h, m, s = ts.split(':')
        sec = float(s)
        cs = int(round((sec - int(sec)) * 100))
        return f'{int(h)}:{int(m):02d}:{int(sec):02d}.{cs:02d}'
    return ts

# ── ASS builder ───────────────────────────────────────────────────────────────

def build_header(play_w, play_h, font_family, font_size, primary_colour,
                 align, margin_v, bold, italic, preset):
    bf  = -1 if bold   else 0
    itf = -1 if italic else 0
    margin_lr = max(20, int(round(play_w * preset.get('_margin_lr_ratio_active', preset['margin_lr_ratio']))))
    return (
        '[Script Info]\nTitle: SubBurner\nScriptType: v4.00+\n'
        f'PlayResX: {play_w}\nPlayResY: {play_h}\n'
        'ScaledBorderAndShadow: yes\nWrapStyle: 1\nYCbCr Matrix: TV.709\n\n'
        '[V4+ Styles]\n'
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, '
        'OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, '
        'ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, '
        'Alignment, MarginL, MarginR, MarginV, Encoding\n'
        f'Style: Default,{font_family},{font_size},{primary_colour},&H0000FFFF,'
        f'{preset["outline_colour"]},{preset["back_colour"]},{bf},{itf},0,0,100,100,'
        f'{preset["spacing"]},0,{preset["border_style"]},{preset["outline"]},'
        f'{preset["shadow"]},{align},{margin_lr},{margin_lr},{margin_v},1\n\n'
        '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
    )

def srt_text_to_ass(srt_text, ass_path, play_w, play_h, preset_key, crop_169=False,
                    sub_pos=None, custom_font_size=None):
    """
    Convert SRT text → ASS file.
    sub_pos: 'top'|'middle'|'bottom' — overrides preset position.
    custom_font_size: int px — overrides preset font size when not in crop_169 mode.
    Returns the font_key used.
    """
    preset    = STYLE_PRESETS.get(preset_key, STYLE_PRESETS['1'])
    font_key  = preset['font_key']
    font_meta = FONTS.get(font_key, FONTS['1'])
    color_hex = COLORS[preset['color_key']][1]

    # Subtitle position — sub_pos overrides preset
    if sub_pos:
        align = sub_pos_to_align(sub_pos)
    else:
        align = POSITIONS[preset['position_key']][1]

    # Use 9:16 ratios when crop_169 is active
    if crop_169 and preset.get('size_ratio_916'):
        size_ratio    = preset['size_ratio_916']
        margin_lr_ratio = preset['margin_lr_ratio_916']
        margin_v_ratio  = preset['margin_v_ratio_916']
    else:
        size_ratio    = SIZES[preset['size_key']][1]
        margin_lr_ratio = preset['margin_lr_ratio']
        margin_v_ratio  = preset['margin_v_ratio']

    font_size = max(20, int(round(play_h * size_ratio)))

    # Override font size if custom_font_size provided (only in non-crop mode)
    if custom_font_size and not crop_169:
        font_size = max(20, int(custom_font_size))

    if crop_169:
        padded_h     = int(round(play_w * 16 / 9))
        video_h_in_pad = play_w
        bottom_black = (padded_h - video_h_in_pad) // 2
        font_size = preset.get('crop_169_font_size', 40)
        margin_v  = bottom_black + preset.get('crop_169_margin_offset', 70)
        play_h    = padded_h
    else:
        margin_v = max(20, int(round(play_h * margin_v_ratio)))

    preset = dict(preset)
    preset['_margin_lr_ratio_active'] = margin_lr_ratio

    blocks    = re.split(r'\n\s*\n', srt_text.strip())
    dialogues = []
    for block in blocks:
        lines = [x.rstrip() for x in block.splitlines() if x.strip()]
        if len(lines) < 2: continue
        if re.fullmatch(r'\d+', lines[0]): lines = lines[1:]
        if not lines or '-->' not in lines[0]: continue
        start_str, end_str = [x.strip() for x in lines[0].split('-->', 1)]
        body = '\n'.join(lines[1:])
        body = strip_html_tags(body).replace('\r', '').replace('\n', r'\N').strip()
        if preset.get('blur', 0):
            body = '{\\blur' + str(preset['blur']) + '}' + body
        dialogues.append((to_ass_time(start_str), to_ass_time(end_str), body))

    header = build_header(
        play_w, play_h, font_meta['family'], font_size, color_hex,
        align, margin_v, preset['bold'], preset['italic'], preset
    )
    body_str = '\n'.join(
        f'Dialogue: 0,{s},{e},Default,,0,0,0,,{t}' for s, e, t in dialogues
    )
    Path(ass_path).write_text(header + body_str + '\n', encoding='utf-8')
    info(f'ASS ready — {len(dialogues)} subtitle lines')
    return font_key

# ── SRT clipping ──────────────────────────────────────────────────────────────

def parse_srt_time_to_seconds(ts):
    ts = ts.strip().replace(',', '.')
    parts = ts.split(':')
    if len(parts) == 3:
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    return 0.0

def clip_srt(srt_text, start_sec, end_sec):
    """Return SRT text trimmed to [start_sec, end_sec], re-based to 0."""
    def sec_to_srt(t):
        t = max(0.0, t)
        h = int(t // 3600); m = int((t % 3600) // 60)
        s_ = int(t % 60);   ms = int(round((t - int(t)) * 1000))
        return f'{h:02d}:{m:02d}:{s_:02d},{ms:03d}'

    blocks = re.split(r'\n\s*\n', srt_text.strip())
    out = []; idx = 1
    for block in blocks:
        lines = [x.rstrip() for x in block.splitlines() if x.strip()]
        if len(lines) < 2: continue
        if re.fullmatch(r'\d+', lines[0]): lines = lines[1:]
        if not lines or '-->' not in lines[0]: continue
        ts, rest = lines[0], lines[1:]
        s_str, e_str = [x.strip() for x in ts.split('-->', 1)]
        s_sec = parse_srt_time_to_seconds(s_str)
        e_sec = parse_srt_time_to_seconds(e_str)
        if e_sec < start_sec or s_sec > end_sec: continue
        new_s = max(0.0, s_sec - start_sec)
        new_e = max(0.0, e_sec - start_sec)
        out.append(f'{idx}\n{sec_to_srt(new_s)} --> {sec_to_srt(new_e)}\n' + '\n'.join(rest))
        idx += 1
    return '\n\n'.join(out) + ('\n\n' if out else '')

# ── FFprobe ───────────────────────────────────────────────────────────────────

def ffprobe_meta(url, referer=''):
    headers_val = 'Accept: */*\r\n'
    if referer:
        headers_val += f'Referer: {referer}\r\nOrigin: {referer}\r\n'
    cmd = [
        'ffprobe', '-v', 'error',
        '-user_agent', 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36',
        '-headers', headers_val,
        *extra_m3u8_args(url),
        '-print_format', 'json', '-show_streams', '-show_format', url,
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=45)
        if r.returncode != 0:
            return 1280, 720, None
        data = json.loads(r.stdout)
        vstream = next((s for s in data.get('streams', []) if s.get('codec_type') == 'video'), None)
        w   = int(vstream.get('width',  1280)) if vstream else 1280
        h   = int(vstream.get('height', 720))  if vstream else 720
        dur = float(data.get('format', {}).get('duration', 0) or 0) or None
        return w, h, dur
    except Exception as e:
        warn(f'ffprobe failed: {e}')
        return 1280, 720, None

# ── FFmpeg runner ─────────────────────────────────────────────────────────────

def parse_ffmpeg_time(line):
    m = re.search(r'time=(\d+):(\d+):(\d+(?:\.\d+)?)', line)
    if not m: return None
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))

def run_ffmpeg(cmd, duration=None, stage='render'):
    info(f'FFmpeg: {" ".join(cmd[:8])} …')
    p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, bufsize=1)
    last_pct = -1
    for line in p.stderr:
        line = line.rstrip()
        if not line: continue
        if 'time=' in line and duration:
            cur = parse_ffmpeg_time(line)
            if cur is not None:
                pct = min(99, int(cur / duration * 100))
                if pct != last_pct:
                    progress(pct, stage)
                    last_pct = pct
        if any(x in line.lower() for x in ['error', 'failed', 'invalid', 'no such file']):
            warn(f'FFmpeg stderr: {line}')
    p.wait()
    return p.returncode

# ── Video filter builder ──────────────────────────────────────────────────────

def build_vf(ass_path, crop_169, clip_title='', color_grade='natural'):
    """
    Return the -vf filter string.
    ass_path=None means no subtitle.
    color_grade: none|natural|bright|vivid|warm|cinema
    """
    has_sub = ass_path is not None
    cg_filter = build_color_grade_filter(color_grade)

    def make_sub_filter():
        esc_ass   = esc_filter(str(ass_path))
        esc_fonts = esc_filter(str(FONTS_DIR))
        return f"ass='{esc_ass}':fontsdir='{esc_fonts}'"

    def make_title_filter(y_pos):
        font_path = str(FONTS_DIR / 'SolaimanLipi.ttf')
        esc_font  = esc_filter(font_path)
        safe = clip_title.replace("'", "\\'").replace(':', '\\:').replace('[', '\\[').replace(']', '\\]')
        return (
            f"drawtext=fontfile='{esc_font}':text='{safe}'"
            f":fontsize=48:fontcolor=white:borderw=3:bordercolor=black"
            f":x=(w-text_w)/2:y={y_pos}:line_spacing=8"
        )

    if crop_169:
        crop  = "crop='min(iw,ih)':'min(iw,ih)'"
        pad   = "pad='iw':'trunc(iw*16/9/2)*2':'0':'(oh-ih)/2'"
        scale = "scale='trunc(iw/2)*2':'trunc(ih/2)*2'"
        base  = f"{crop},{pad},{scale}"
        parts = [base]
        if cg_filter:    parts.append(cg_filter)
        if clip_title:   parts.append(make_title_filter(60))
        if has_sub:      parts.append(make_sub_filter())
        return ','.join(parts)
    else:
        parts = []
        if cg_filter:    parts.append(cg_filter)
        if clip_title:   parts.append(make_title_filter(40))
        if has_sub:      parts.append(make_sub_filter())
        return ','.join(parts) if parts else 'null'

# ── Render helpers ────────────────────────────────────────────────────────────

def make_headers_val(referer):
    val = 'Accept: */*\r\n'
    if referer:
        val += f'Referer: {referer}\r\nOrigin: {referer}\r\n'
    return val

def is_m3u8(url):
    return '.m3u8' in (url or '').lower()

def extra_m3u8_args(url):
    """Return extra ffmpeg args needed for HLS/m3u8 streams."""
    if is_m3u8(url):
        return ['-allowed_extensions', 'ALL']
    return []

def build_audio_mix_args(bgm_path):
    """
    Return extra ffmpeg input + filter_complex args for BGM mixing.
    bgm_path: path to pre-processed BGM audio file (already trimmed + volume adjusted).
    Returns (extra_inputs, audio_filter_args) both as lists.
    """
    if not bgm_path or not Path(bgm_path).exists():
        return [], []
    # Mix original audio with BGM: amix with original taking priority
    extra_inputs = ['-i', bgm_path]
    audio_filter = [
        '-filter_complex', '[1:a]aloop=loop=-1:size=2e+09[bgmloop];[0:a][bgmloop]amix=inputs=2:duration=first:weights=1 1[aout]',
        '-map', '0:v', '-map', '[aout]',
    ]
    return extra_inputs, audio_filter

def render_full(video_url, referer, ass_path, out_path, duration, crop_169,
                color_grade='natural', bgm_path=None):
    proxy = os.environ.get('FFMPEG_HTTP_PROXY', '')
    proxy_args = ['-http_proxy', proxy] if proxy else []
    vf = build_vf(ass_path, crop_169, color_grade=color_grade)

    bgm_inputs, bgm_audio = build_audio_mix_args(bgm_path)

    if bgm_audio:
        cmd = [
            'ffmpeg', '-y',
            '-user_agent', 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36',
            '-headers', make_headers_val(referer),
            *extra_m3u8_args(video_url),
            *proxy_args,
            '-i', video_url,
            *bgm_inputs,
            '-vf', vf,
            *bgm_audio,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
            '-c:a', 'aac', '-b:a', '128k',
            '-movflags', '+faststart',
            out_path,
        ]
    else:
        cmd = [
            'ffmpeg', '-y',
            '-user_agent', 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36',
            '-headers', make_headers_val(referer),
            *extra_m3u8_args(video_url),
            *proxy_args,
            '-i', video_url,
            '-vf', vf,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
            '-c:a', 'aac', '-b:a', '128k',
            '-movflags', '+faststart',
            out_path,
        ]
    return run_ffmpeg(cmd, duration, 'render')

def render_clip(video_url, referer, ass_path, out_path, start_sec, clip_dur, crop_169,
                clip_title='', color_grade='natural', bgm_path=None):
    proxy = os.environ.get('FFMPEG_HTTP_PROXY', '')
    proxy_args = ['-http_proxy', proxy] if proxy else []
    vf = build_vf(ass_path, crop_169, clip_title=clip_title, color_grade=color_grade)

    bgm_inputs, bgm_audio = build_audio_mix_args(bgm_path)

    if bgm_audio:
        cmd = [
            'ffmpeg', '-y',
            '-user_agent', 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36',
            '-headers', make_headers_val(referer),
            *extra_m3u8_args(video_url),
            *proxy_args,
            '-ss', str(start_sec),
            '-i', video_url,
            '-t', str(clip_dur),
            *bgm_inputs,
            '-vf', vf,
            *bgm_audio,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
            '-c:a', 'aac', '-b:a', '128k',
            '-movflags', '+faststart',
            out_path,
        ]
    else:
        cmd = [
            'ffmpeg', '-y',
            '-user_agent', 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36',
            '-headers', make_headers_val(referer),
            *extra_m3u8_args(video_url),
            *proxy_args,
            '-ss', str(start_sec),
            '-i', video_url,
            '-t', str(clip_dur),
            '-vf', vf,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
            '-c:a', 'aac', '-b:a', '128k',
            '-movflags', '+faststart',
            out_path,
        ]
    return run_ffmpeg(cmd, clip_dur, 'clip')

# ── Upload helpers ────────────────────────────────────────────────────────────

def _multipart_upload(url, fields, file_field, file_path, timeout=300):
    """Simple multipart/form-data upload using stdlib only."""
    boundary = b'----SubBurnerBoundary7734'
    parts = bytearray()
    for name, value in fields.items():
        parts += (
            b'--' + boundary + b'\r\n'
            b'Content-Disposition: form-data; name="' + name.encode() + b'"\r\n\r\n'
            + str(value).encode() + b'\r\n'
        )
    fname = os.path.basename(file_path).encode()
    with open(file_path, 'rb') as fh:
        file_data = fh.read()
    parts += (
        b'--' + boundary + b'\r\n'
        b'Content-Disposition: form-data; name="' + file_field.encode() + b'"; filename="' + fname + b'"\r\n'
        b'Content-Type: video/mp4\r\n\r\n'
        + file_data + b'\r\n'
        + b'--' + boundary + b'--\r\n'
    )
    body = bytes(parts)
    req = urllib.request.Request(url, data=body, method='POST')
    req.add_header('Content-Type', f'multipart/form-data; boundary={boundary.decode()}')
    req.add_header('Content-Length', str(len(body)))
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())

def upload_telegram(file_path, title, bot_token, chat_id):
    size_mb = round(os.path.getsize(file_path) / 1048576, 1)
    info(f'Uploading to Telegram ({size_mb} MB) …')
    if size_mb > 49:
        warn('File >49 MB — Telegram Bot API limit is 50 MB. Upload may fail.')
    url = f'https://api.telegram.org/bot{bot_token}/sendVideo'
    try:
        result = _multipart_upload(
            url,
            {'chat_id': str(chat_id), 'caption': f'**{title}**', 'supports_streaming': 'true'},
            'video', file_path
        )
        if result.get('ok'):
            msg = result['result']
            mid = msg.get('message_id', '')
            cid = str(chat_id).replace('-100', '')
            link = f'https://t.me/c/{cid}/{mid}' if str(chat_id).startswith('-100') else None
            info(f'Telegram OK — message_id={mid}')
            return link
        else:
            err(f'Telegram API error: {result.get("description", "unknown")}')
            return None
    except Exception as e:
        err(f'Telegram upload failed: {e}')
        return None

def upload_facebook(file_path, title, page_token, page_id):
    size_mb = round(os.path.getsize(file_path) / 1048576, 1)
    info(f'Uploading to Facebook Page ({size_mb} MB) …')
    url = f'https://graph.facebook.com/v19.0/{page_id}/videos'
    try:
        result = _multipart_upload(
            url,
            {'access_token': page_token, 'title': title, 'published': 'true'},
            'source', file_path
        )
        vid_id = result.get('id')
        if vid_id:
            info(f'Facebook OK — video_id={vid_id}')
            return f'https://www.facebook.com/video/{vid_id}'
        else:
            err(f'Facebook error: {result}')
            return None
    except Exception as e:
        err(f'Facebook upload failed: {e}')
        return None

def upload_youtube(file_path, title, access_token):
    size_mb = round(os.path.getsize(file_path) / 1048576, 1)
    info(f'Uploading to YouTube ({size_mb} MB) …')
    file_size = os.path.getsize(file_path)
    meta = json.dumps({
        'snippet': {'title': title, 'description': '', 'categoryId': '22'},
        'status': {'privacyStatus': 'private'},
    })
    init_url = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status'
    req = urllib.request.Request(init_url, data=meta.encode(), method='POST')
    req.add_header('Authorization', f'Bearer {access_token}')
    req.add_header('Content-Type', 'application/json; charset=UTF-8')
    req.add_header('X-Upload-Content-Type', 'video/mp4')
    req.add_header('X-Upload-Content-Length', str(file_size))
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            upload_url = resp.headers.get('Location')
    except Exception as e:
        err(f'YouTube init failed: {e}')
        return None
    if not upload_url:
        err('No upload URL returned from YouTube')
        return None
    with open(file_path, 'rb') as fh:
        data = fh.read()
    req2 = urllib.request.Request(upload_url, data=data, method='PUT')
    req2.add_header('Content-Type', 'video/mp4')
    req2.add_header('Content-Length', str(file_size))
    try:
        with urllib.request.urlopen(req2, timeout=600) as resp:
            result = json.loads(resp.read().decode())
            vid_id = result.get('id')
            if vid_id:
                info(f'YouTube OK — video_id={vid_id}')
                return f'https://youtu.be/{vid_id}'
            else:
                err(f'YouTube response: {result}')
                return None
    except Exception as e:
        err(f'YouTube upload failed: {e}')
        return None

def do_uploads(file_path, title, uploads_cfg, drive_folder=''):
    """Upload to all configured targets. Returns links dict including drive status."""
    links = {}
    tg = uploads_cfg.get('telegram', {})
    if tg.get('enabled') and tg.get('bot_token') and tg.get('chat_id'):
        links['telegram'] = upload_telegram(file_path, title, tg['bot_token'], tg['chat_id'])
    fb = uploads_cfg.get('facebook', {})
    if fb.get('enabled') and fb.get('page_token') and fb.get('page_id'):
        links['facebook'] = upload_facebook(file_path, title, fb['page_token'], fb['page_id'])
    yt = uploads_cfg.get('youtube', {})
    if yt.get('enabled') and yt.get('access_token'):
        links['youtube'] = upload_youtube(file_path, title, yt['access_token'])

    # Google Drive upload
    if drive_folder and drive_folder.strip():
        info(f'Uploading to Google Drive …')
        ok, drive_url = upload_to_drive(file_path, drive_folder)
        if ok:
            links['drive_ok'] = drive_url or drive_folder
            info(f'Drive upload OK: {drive_url}')
        else:
            links['drive_fail'] = True
            warn('Drive upload failed')

    return links

# ── timestamp parser ──────────────────────────────────────────────────────────

def parse_ts(ts):
    """HH:MM:SS or MM:SS or seconds float."""
    ts = str(ts).strip()
    parts = ts.split(':')
    if len(parts) == 3:
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    if len(parts) == 2:
        return int(parts[0]) * 60 + float(parts[1])
    return float(ts)

# ── main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True, help='Path to JSON job config')
    args = parser.parse_args()

    with open(args.config, encoding='utf-8') as fh:
        cfg = json.load(fh)

    mode        = cfg.get('mode', 'full')
    video_url   = cfg.get('video_url', '')
    referer     = cfg.get('referer', '')
    srt_path    = cfg.get('srt_path')
    preset_key  = str(cfg.get('preset', '1'))
    crop_169    = bool(cfg.get('crop_169', False))
    output_dir  = cfg['output_dir']
    job_id      = cfg['job_id']
    title       = cfg.get('title', 'SubBurner Video')
    uploads_cfg = cfg.get('uploads', {})
    clips       = cfg.get('clips', [])
    sources     = cfg.get('sources', [])
    recap_merge = bool(cfg.get('recap_merge', True))

    # ── New fields ──────────────────────────────────────────────────────────
    color_grade  = cfg.get('color_grade', 'natural')
    sub_pos      = cfg.get('sub_pos', 'bottom')
    custom_fs    = cfg.get('font_size', None)   # custom font size in px
    bgm_cfg      = cfg.get('bgm', None)          # {url, start, end, volume} or null
    drive_folder = cfg.get('drive_folder', '')

    Path(output_dir).mkdir(parents=True, exist_ok=True)

    # Load SRT (optional)
    srt_text = ''
    if srt_path and Path(srt_path).exists():
        info('Loading subtitle …')
        srt_text = Path(srt_path).read_text(encoding='utf-8', errors='replace')
        count = sum(1 for ln in srt_text.splitlines() if '-->' in ln)
        info(f'SRT loaded: {count} entries')
    else:
        info('No subtitle file — rendering without subtitles.')

    preset = STYLE_PRESETS.get(preset_key, STYLE_PRESETS['1'])
    ensure_font(preset['font_key'])

    info(f'Color grade: {color_grade} | Sub position: {sub_pos} | Font size: {custom_fs or "auto"}px')
    if bgm_cfg: info(f'BGM enabled: {bgm_cfg.get("url","")[:60]} vol={bgm_cfg.get("volume",30)}%')
    if drive_folder: info(f'Drive folder: {drive_folder[:60]}')

    # ── Pre-fetch BGM if needed ────────────────────────────────────────────
    bgm_path = None
    if mode in ('full', 'clip', 'recap') and bgm_cfg and bgm_cfg.get('url'):
        bgm_path = fetch_bgm(bgm_cfg, output_dir)

    if mode == 'full':
        # ── Full Render ──────────────────────────────────────────────────────
        info(f'Probing video …')
        play_w, play_h, duration = ffprobe_meta(video_url, referer)
        info(f'Video: {play_w}x{play_h}, duration={fmt_time(duration)}')
        info(f'=== Full Render | preset={preset["name"]} | crop_169={crop_169} | color={color_grade} ===')
        ass_path = os.path.join(output_dir, 'subtitle.ass')
        if srt_text:
            srt_text_to_ass(srt_text, ass_path, play_w, play_h, preset_key,
                            crop_169=crop_169, sub_pos=sub_pos, custom_font_size=custom_fs)
        else:
            ass_path = None
        out_path = os.path.join(output_dir, f'{job_id}_output.mp4')
        info('Starting FFmpeg …')
        rc = render_full(video_url, referer, ass_path, out_path, duration, crop_169,
                         color_grade=color_grade, bgm_path=bgm_path)
        if rc != 0 or not os.path.exists(out_path):
            err('FFmpeg render failed (non-zero exit)')
            emit({'type': 'error', 'msg': 'FFmpeg render failed'})
            return
        size_mb = round(os.path.getsize(out_path) / 1048576, 1)
        info(f'Render done: {size_mb} MB')
        progress(95, 'render_done')
        info('Starting uploads …')
        links = do_uploads(out_path, title, uploads_cfg, drive_folder=drive_folder)
        progress(100, 'done')
        emit({'type': 'done', 'outputs': [{'file': os.path.basename(out_path), 'links': links}]})

    elif mode == 'clip':
        # ── Clip Mode ────────────────────────────────────────────────────────
        info(f'Probing video …')
        play_w, play_h, duration = ffprobe_meta(video_url, referer)
        info(f'Video: {play_w}x{play_h}, duration={fmt_time(duration)}')
        total = len(clips)
        info(f'=== Clip Mode: {total} clips | preset={preset["name"]} | crop_169={crop_169} | color={color_grade} ===')
        results = []
        for i, clip in enumerate(clips):
            clip_title  = clip.get('title', f'Clip {i + 1}')
            start_sec   = parse_ts(clip['start'])
            end_sec     = parse_ts(clip['end'])
            clip_dur    = max(1.0, end_sec - start_sec)
            info(f'--- Clip {i+1}/{total}: "{clip_title}" {clip["start"]}→{clip["end"]} ({fmt_time(clip_dur)}) ---')
            emit({'type': 'clip_start', 'index': i, 'title': clip_title})

            clip_ass_path = None
            if srt_text:
                clipped_srt   = clip_srt(srt_text, start_sec, end_sec)
                clip_srt_path = os.path.join(output_dir, f'clip_{i+1:02d}.srt')
                Path(clip_srt_path).write_text(clipped_srt, encoding='utf-8')
                clip_ass_path = os.path.join(output_dir, f'clip_{i+1:02d}.ass')
                srt_text_to_ass(clipped_srt, clip_ass_path, play_w, play_h, preset_key,
                                crop_169=crop_169, sub_pos=sub_pos, custom_font_size=custom_fs)

            safe = re.sub(r'[\\/:"*?<>|\n\r\t]', ' ', clip_title).strip()[:60] or f'clip{i+1}'
            out_name = f'{job_id}_clip{i+1:02d}_{safe}.mp4'
            out_path = os.path.join(output_dir, out_name)
            rc = render_clip(video_url, referer, clip_ass_path, out_path, start_sec, clip_dur, crop_169,
                             clip_title=clip_title, color_grade=color_grade, bgm_path=bgm_path)

            if rc != 0 or not os.path.exists(out_path):
                err(f'Clip {i+1} render failed')
                results.append({'clip': i + 1, 'title': clip_title, 'error': 'render failed', 'file': None})
                emit({'type': 'clip_done', 'index': i, 'status': 'failed', 'title': clip_title})
                continue

            size_mb = round(os.path.getsize(out_path) / 1048576, 1)
            info(f'Clip {i+1} rendered: {size_mb} MB')
            base_pct = int((i + 1) / total * 85)
            progress(base_pct, f'clip_{i+1}_rendered')

            links = do_uploads(out_path, clip_title, uploads_cfg, drive_folder=drive_folder)
            results.append({'clip': i + 1, 'title': clip_title, 'file': out_name, 'links': links})
            emit({'type': 'clip_done', 'index': i, 'status': 'ready',
                  'title': clip_title, 'file': out_name, 'links': links})
            progress(base_pct + 5, f'clip_{i+1}_uploaded')

        progress(100, 'done')
        emit({'type': 'done', 'outputs': results})

    elif mode == 'recap':
        # ── নাটক রিক্যাপ Mode ─────────────────────────────────────────────────
        info(f'=== নাটক রিক্যাপ Mode | {len(sources)} source(s) | preset={preset["name"]} | color={color_grade} ===')

        # Recap-specific BGM override if provided
        recap_bgm_cfg = cfg.get('bgm', bgm_cfg)
        recap_bgm_path = bgm_path  # already fetched above if same bgm_cfg

        segment_paths = []
        total_clips   = sum(len(s.get('clips', [])) for s in sources)
        done_clips    = 0

        for si, source in enumerate(sources):
            src_url     = source.get('url', '')
            src_referer = source.get('referer', referer)
            src_clips   = source.get('clips', [])
            if not src_url or not src_clips:
                warn(f'Source {si+1}: url বা clips নেই, skip করা হলো।')
                continue

            info(f'--- Source {si+1}/{len(sources)}: {src_url[:80]} ({len(src_clips)} clip(s)) ---')
            info(f'Probing source {si+1} …')
            try:
                play_w, play_h, src_dur = ffprobe_meta(src_url, src_referer)
                info(f'Source {si+1}: {play_w}x{play_h}, {fmt_time(src_dur)}')
            except Exception as e:
                err(f'Source {si+1} probe failed: {e}')
                continue

            for ci, clip in enumerate(src_clips):
                start_sec = parse_ts(clip['start'])
                end_sec   = parse_ts(clip['end'])
                clip_dur  = max(1.0, end_sec - start_sec)
                seg_label = f's{si+1}_c{ci+1}'
                info(f'  Clip {seg_label}: {clip["start"]}→{clip["end"]} ({fmt_time(clip_dur)})')

                seg_ass_path = None
                if srt_text:
                    seg_srt  = clip_srt(srt_text, start_sec, end_sec)
                    seg_srt_path = os.path.join(output_dir, f'seg_{seg_label}.srt')
                    Path(seg_srt_path).write_text(seg_srt, encoding='utf-8')
                    seg_ass_path = os.path.join(output_dir, f'seg_{seg_label}.ass')
                    srt_text_to_ass(seg_srt, seg_ass_path, play_w, play_h, preset_key,
                                    crop_169=crop_169, sub_pos=sub_pos, custom_font_size=custom_fs)

                seg_out = os.path.join(output_dir, f'seg_{seg_label}.mp4')
                rc = render_clip(src_url, src_referer, seg_ass_path, seg_out, start_sec, clip_dur, crop_169,
                                 color_grade=color_grade, bgm_path=None)  # BGM added after concat

                if rc != 0 or not os.path.exists(seg_out):
                    err(f'Segment {seg_label} render failed — skip')
                    done_clips += 1
                    progress(int(done_clips / total_clips * 80), f'seg_{seg_label}_failed')
                    continue

                segment_paths.append(seg_out)
                done_clips += 1
                pct = int(done_clips / total_clips * 80)
                progress(pct, f'seg_{seg_label}_done')
                info(f'  ✅ Segment {seg_label} ready ({round(os.path.getsize(seg_out)/1048576,1)} MB)')

        if not segment_paths:
            err('কোনো segment render হয়নি — job failed')
            emit({'type': 'error', 'msg': 'No segments rendered successfully'})
            return

        # Concat all segments
        info(f'🎬 Concat করা হচ্ছে {len(segment_paths)}টা segment → একটা video …')
        progress(82, 'concat')

        concat_list_path = os.path.join(output_dir, 'concat_list.txt')
        with open(concat_list_path, 'w', encoding='utf-8') as cf:
            for sp in segment_paths:
                cf.write(f"file '{sp}'\n")

        # If BGM provided, mix after concat; otherwise direct copy
        if recap_bgm_path and Path(recap_bgm_path).exists():
            concat_raw = os.path.join(output_dir, f'{job_id}_recap_raw.mp4')
            concat_cmd = [
                'ffmpeg', '-y',
                '-f', 'concat', '-safe', '0',
                '-i', concat_list_path,
                '-c', 'copy',
                concat_raw,
            ]
            rc = run_ffmpeg(concat_cmd, None, 'concat')
            if rc != 0 or not Path(concat_raw).exists():
                err('FFmpeg concat failed')
                emit({'type': 'error', 'msg': 'Concat failed'})
                return
            # Now mix BGM
            final_out = os.path.join(output_dir, f'{job_id}_recap.mp4')
            info('Mixing BGM into recap …')
            bgm_inputs, bgm_audio = build_audio_mix_args(recap_bgm_path)
            mix_cmd = [
                'ffmpeg', '-y',
                '-i', concat_raw,
                *bgm_inputs,
                *bgm_audio,
                '-c:v', 'copy',
                '-c:a', 'aac', '-b:a', '128k',
                '-movflags', '+faststart',
                final_out,
            ]
            rc = run_ffmpeg(mix_cmd, None, 'bgm_mix')
            try: os.remove(concat_raw)
            except: pass
        else:
            final_out = os.path.join(output_dir, f'{job_id}_recap.mp4')
            concat_cmd = [
                'ffmpeg', '-y',
                '-f', 'concat', '-safe', '0',
                '-i', concat_list_path,
                '-c', 'copy',
                final_out,
            ]
            rc = run_ffmpeg(concat_cmd, None, 'concat')

        if rc != 0 or not os.path.exists(final_out):
            err('FFmpeg concat/mix failed')
            emit({'type': 'error', 'msg': 'Concat failed'})
            return

        size_mb = round(os.path.getsize(final_out) / 1048576, 1)
        info(f'✅ Final recap video ready: {size_mb} MB')
        progress(92, 'concat_done')

        for sp in segment_paths:
            try: os.remove(sp)
            except: pass

        info('Starting uploads …')
        links = do_uploads(final_out, title, uploads_cfg, drive_folder=drive_folder)
        progress(100, 'done')
        emit({'type': 'done', 'outputs': [{'file': os.path.basename(final_out), 'links': links}]})

    elif mode == 'screenshot_recap':
        # ── Screenshot Recap Mode ─────────────────────────────────────────────
        info(f'=== Screenshot Recap Mode ===')

        sr_timestamps  = cfg.get('sr_timestamps', [])
        sr_audio_path  = cfg.get('sr_audio_path', '')
        sr_atempo      = float(cfg.get('sr_atempo', 0.85))
        sr_drive_folder = cfg.get('sr_drive_folder', '') or drive_folder  # fallback to global
        sr_kb_effect   = cfg.get('sr_kb_effect', 'random')  # random|zoom_in|zoom_out|pan_left|pan_right|none
        sr_ss_quality  = str(cfg.get('sr_ss_quality', '2'))  # ffmpeg -q:v value
        sr_bgm_cfg     = cfg.get('sr_bgm', None)

        src_url     = sources[0].get('url', video_url)    if sources else video_url
        src_referer = sources[0].get('referer', referer)  if sources else referer

        if not sr_timestamps:
            err('sr_timestamps empty — screenshot_recap needs at least one timestamp')
            emit({'type': 'error', 'msg': 'sr_timestamps required'})
            return

        if not sr_audio_path or not Path(sr_audio_path).exists():
            err(f'sr_audio_path not found: {sr_audio_path}')
            emit({'type': 'error', 'msg': 'audio file not found on server'})
            return

        # Step 1: Get audio duration
        info('Getting audio duration …')
        try:
            probe_r = subprocess.run(
                ['ffprobe', '-v', 'quiet', '-show_entries', 'format=duration',
                 '-of', 'csv=p=0', sr_audio_path],
                capture_output=True, text=True, timeout=15
            )
            audio_dur = float(probe_r.stdout.strip())
            info(f'Audio duration: {fmt_time(audio_dur)}')
        except Exception as e:
            err(f'Could not get audio duration: {e}')
            emit({'type': 'error', 'msg': 'Cannot read audio duration'})
            return

        # Apply atempo
        sped_audio_path = os.path.join(output_dir, 'audio_sped.mp3')
        info(f'Applying atempo={sr_atempo} to audio …')
        atempo_filter = f'atempo={sr_atempo}'
        if sr_atempo < 0.5:
            atempo_filter = f'atempo=0.5,atempo={sr_atempo/0.5:.4f}'
        elif sr_atempo > 2.0:
            atempo_filter = f'atempo=2.0,atempo={sr_atempo/2.0:.4f}'

        atempo_cmd = [
            'ffmpeg', '-y', '-i', sr_audio_path,
            '-filter:a', atempo_filter,
            '-c:a', 'libmp3lame', '-b:a', '128k',
            sped_audio_path
        ]
        rc = subprocess.run(atempo_cmd, capture_output=True).returncode
        if rc != 0 or not Path(sped_audio_path).exists():
            warn('atempo failed, using original audio')
            sped_audio_path = sr_audio_path

        try:
            probe_r2 = subprocess.run(
                ['ffprobe', '-v', 'quiet', '-show_entries', 'format=duration',
                 '-of', 'csv=p=0', sped_audio_path],
                capture_output=True, text=True, timeout=15
            )
            audio_dur = float(probe_r2.stdout.strip())
            info(f'Sped audio duration: {fmt_time(audio_dur)}')
        except Exception:
            pass

        # Step 2: Take screenshots via FFmpeg
        total_ts = len(sr_timestamps)
        sec_per_shot = audio_dur / total_ts
        info(f'Timestamps: {total_ts} | sec/screenshot: {sec_per_shot:.2f}s')

        proxy = os.environ.get('FFMPEG_HTTP_PROXY', '')
        proxy_args = ['-http_proxy', proxy] if proxy else []
        headers_val = make_headers_val(src_referer)

        screenshot_paths = []
        for i, ts_item in enumerate(sr_timestamps):
            ts_str  = ts_item if isinstance(ts_item, str) else ts_item.get('time', '00:00:00')
            ts_type = 'normal' if isinstance(ts_item, str) else ts_item.get('type', 'normal')
            ss_path = os.path.join(output_dir, f'shot_{i:04d}.png')

            info(f'Screenshot {i+1}/{total_ts}: {ts_str} (type={ts_type})')
            shot_cmd = [
                'ffmpeg', '-y',
                '-user_agent', 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36',
                '-headers', headers_val,
                *extra_m3u8_args(src_url),
                *proxy_args,
                '-ss', ts_str,
                '-i', src_url,
                '-vframes', '1',
                '-q:v', sr_ss_quality,
                ss_path
            ]
            rc = subprocess.run(shot_cmd, capture_output=True, timeout=60).returncode
            if rc != 0 or not Path(ss_path).exists():
                warn(f'Screenshot {i+1} failed, creating black frame …')
                fallback_cmd = [
                    'ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=black:s=1280x720:r=1',
                    '-vframes', '1', ss_path
                ]
                subprocess.run(fallback_cmd, capture_output=True)

            screenshot_paths.append((ss_path, ts_type))
            pct = int((i + 1) / total_ts * 50)
            progress(pct, f'screenshot_{i+1}')

        if not screenshot_paths:
            err('No screenshots captured')
            emit({'type': 'error', 'msg': 'Screenshot capture failed'})
            return

        # Step 3: Get screenshot dimensions
        try:
            dim_r = subprocess.run(
                ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
                 '-show_entries', 'stream=width,height', '-of', 'csv=p=0',
                 screenshot_paths[0][0]],
                capture_output=True, text=True, timeout=10
            )
            w_str, h_str = dim_r.stdout.strip().split(',')
            shot_w, shot_h = int(w_str), int(h_str)
        except Exception:
            shot_w, shot_h = 1280, 720
        info(f'Screenshot size: {shot_w}x{shot_h}')

        # Step 4: Build animated video from screenshots
        info('Building animated screenshot clips …')
        progress(52, 'building_clips')

        import random as _random

        def pick_kb_effect(ts_type, effect_mode):
            """Pick zoompan effect based on ts_type and global effect_mode."""
            if effect_mode == 'none':
                return 'static'
            if effect_mode != 'random':
                return effect_mode
            # random pick for normal scenes
            if ts_type in ('start', 'end', 'emotional'):
                return ts_type
            return _random.choice(['zoom_in', 'zoom_out', 'pan_left', 'pan_right'])

        seg_clips = []

        for i, (ss_path, ts_type) in enumerate(screenshot_paths):
            seg_out = os.path.join(output_dir, f'seg_{i:04d}.mp4')
            dur     = sec_per_shot
            total_frames = int(dur * 25)

            chosen = pick_kb_effect(ts_type, sr_kb_effect)

            if chosen == 'start' or ts_type == 'start':
                vf = (
                    f"zoompan=z='1':x='0':y='0':d={total_frames}:s={shot_w}x{shot_h}:fps=25,"
                    f"fade=t=in:st=0:d=0.8"
                )
            elif chosen == 'end' or ts_type == 'end':
                vf = (
                    f"zoompan=z='1':x='0':y='0':d={total_frames}:s={shot_w}x{shot_h}:fps=25,"
                    f"fade=t=out:st={max(0, dur-0.8):.2f}:d=0.8"
                )
            elif chosen == 'emotional' or ts_type == 'emotional':
                vf = (
                    f"zoompan=z='1':x='0':y='0':d={total_frames}:s={shot_w}x{shot_h}:fps=25,"
                    f"fade=t=in:st=0:d=0.5,"
                    f"fade=t=out:st={max(0, dur-0.5):.2f}:d=0.5"
                )
            elif chosen == 'static':
                vf = (
                    f"zoompan=z='1':x='0':y='0':d={total_frames}:s={shot_w}x{shot_h}:fps=25"
                )
            elif chosen == 'zoom_out':
                vf = (
                    f"zoompan="
                    f"z='max(1.0,1.08-0.0003*on)':"
                    f"x='iw/2-(iw/zoom/2)':"
                    f"y='ih/2-(ih/zoom/2)':"
                    f"d={total_frames}:"
                    f"s={shot_w}x{shot_h}:"
                    f"fps=25"
                )
            elif chosen == 'pan_left':
                vf = (
                    f"zoompan="
                    f"z='1.04':"
                    f"x='iw/zoom/2+{shot_w}*0.03*on/{total_frames}':"
                    f"y='ih/2-(ih/zoom/2)':"
                    f"d={total_frames}:"
                    f"s={shot_w}x{shot_h}:"
                    f"fps=25"
                )
            elif chosen == 'pan_right':
                vf = (
                    f"zoompan="
                    f"z='1.04':"
                    f"x='iw/2-(iw/zoom/2)-{shot_w}*0.03*on/{total_frames}':"
                    f"y='ih/2-(ih/zoom/2)':"
                    f"d={total_frames}:"
                    f"s={shot_w}x{shot_h}:"
                    f"fps=25"
                )
            else:
                # Default: zoom_in (original behavior)
                vf = (
                    f"zoompan="
                    f"z='min(zoom+0.0003,1.08)':"
                    f"x='iw/2-(iw/zoom/2)+{shot_w}*0.02*on/{total_frames}':"
                    f"y='ih/2-(ih/zoom/2)':"
                    f"d={total_frames}:"
                    f"s={shot_w}x{shot_h}:"
                    f"fps=25"
                )

            seg_cmd = [
                'ffmpeg', '-y',
                '-loop', '1',
                '-i', ss_path,
                '-t', str(dur),
                '-vf', vf,
                '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
                '-pix_fmt', 'yuv420p',
                '-r', '25',
                seg_out
            ]
            rc = subprocess.run(seg_cmd, capture_output=True, timeout=120).returncode
            if rc != 0 or not Path(seg_out).exists():
                warn(f'Segment {i} animation failed, using static fallback')
                static_cmd = [
                    'ffmpeg', '-y', '-loop', '1', '-i', ss_path,
                    '-t', str(dur),
                    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
                    '-pix_fmt', 'yuv420p', '-r', '25',
                    seg_out
                ]
                subprocess.run(static_cmd, capture_output=True, timeout=60)

            if Path(seg_out).exists():
                seg_clips.append(seg_out)

            pct = 52 + int((i + 1) / total_ts * 30)
            progress(pct, f'anim_{i+1}')

        if not seg_clips:
            err('No animated clips built')
            emit({'type': 'error', 'msg': 'Animation failed'})
            return

        # Step 5: Concat video segments
        info(f'Concatenating {len(seg_clips)} segments …')
        progress(83, 'concat')

        concat_list = os.path.join(output_dir, 'concat_shots.txt')
        with open(concat_list, 'w', encoding='utf-8') as cf:
            for sp in seg_clips:
                cf.write(f"file '{sp}'\n")

        concat_video = os.path.join(output_dir, 'concat_video.mp4')
        concat_cmd = [
            'ffmpeg', '-y',
            '-f', 'concat', '-safe', '0',
            '-i', concat_list,
            '-c', 'copy',
            concat_video
        ]
        rc = subprocess.run(concat_cmd, capture_output=True, timeout=300).returncode
        if rc != 0 or not Path(concat_video).exists():
            err('Video concat failed')
            emit({'type': 'error', 'msg': 'Video concat failed'})
            return

        # Step 6: Mix narration audio + optional BGM into final video
        info('Mixing audio into final video …')
        progress(88, 'mixing')

        final_out = os.path.join(output_dir, f'{job_id}_screenshot_recap.mp4')

        # Fetch SR BGM if provided
        sr_bgm_path = None
        if sr_bgm_cfg and sr_bgm_cfg.get('url'):
            sr_bgm_path = fetch_bgm(sr_bgm_cfg, output_dir)

        if sr_bgm_path and Path(sr_bgm_path).exists():
            # Mix narration (primary) + BGM (secondary)
            mix_cmd = [
                'ffmpeg', '-y',
                '-i', concat_video,
                '-i', sped_audio_path,
                '-i', sr_bgm_path,
                '-filter_complex',
                '[2:a]aloop=loop=-1:size=2e+09[bgmloop];[1:a][bgmloop]amix=inputs=2:duration=first:weights=3 1[aout]',
                '-map', '0:v', '-map', '[aout]',
                '-c:v', 'copy',
                '-c:a', 'aac', '-b:a', '128k',
                '-shortest',
                '-movflags', '+faststart',
                final_out
            ]
        else:
            mix_cmd = [
                'ffmpeg', '-y',
                '-i', concat_video,
                '-i', sped_audio_path,
                '-c:v', 'copy',
                '-c:a', 'aac', '-b:a', '128k',
                '-shortest',
                '-movflags', '+faststart',
                final_out
            ]
        rc = subprocess.run(mix_cmd, capture_output=True, timeout=300).returncode
        if rc != 0 or not Path(final_out).exists():
            err('Audio mix failed')
            emit({'type': 'error', 'msg': 'Audio mix failed'})
            return

        size_mb = round(os.path.getsize(final_out) / 1048576, 1)
        info(f'✅ Screenshot Recap ready: {size_mb} MB')
        progress(92, 'render_done')

        # Cleanup
        for sp in seg_clips:
            try: os.remove(sp)
            except: pass
        try: os.remove(concat_video)
        except: pass

        # Upload
        info('Starting uploads …')
        effective_drive = sr_drive_folder or drive_folder
        links = do_uploads(final_out, title, uploads_cfg, drive_folder=effective_drive)
        progress(100, 'done')
        emit({'type': 'done', 'outputs': [{'file': os.path.basename(final_out), 'links': links}]})

    else:
        err(f'Unknown mode: {mode}')
        emit({'type': 'error', 'msg': f'Unknown mode: {mode}'})

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        err(f'Fatal: {e}')
        err(traceback.format_exc())
        emit({'type': 'error', 'msg': str(e)})
        sys.exit(1)
