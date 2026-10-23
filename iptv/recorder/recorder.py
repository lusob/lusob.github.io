#!/usr/bin/env python3
"""IPTV recorder for a Raspberry Pi (Python standard library + ffmpeg).

- Serves the web app (proxied from GitHub Pages, cached) so it can be opened at http://<pi>:8090
  on the home network, where it talks to this recorder without mixed-content problems.
- Keeps the app's own data (favourites, teams, reminders, «continue watching»…) so every screen
  that opens the app from here shares it: /api/sync, a key → value store with a revision number.
- Records scheduled programmes with ffmpeg (stream copy) as HLS on the USB stick. When the
  channel fails or cuts out it switches to the next backup channel; each stretch is a "part" and
  the recording's playlist joins them, so it can be watched from the start while still recording.

Usage: recorder.py [--port 8090] [--data /mnt/pendrive/iptv] [--conf ~/iptv-rec/conf.json]
"""

import argparse
import json
import math
import os
import re
import shutil
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = '1'
APP_ORIGIN = 'https://lusob.github.io/iptv/'
STALL = 40            # s without a new segment → the source is considered cut
FIRST_DATA = 45       # s allowed for the first segment of a new source
SWITCH_PAUSE = 3      # s between sources so the provider frees the single connection
MIN_FREE = 2 * 1024**3
GAP_MIN = 10          # s lost before it counts as a cut (a reconnection takes a few seconds)

ap = argparse.ArgumentParser()
ap.add_argument('--port', type=int, default=8090)
ap.add_argument('--data', default='/mnt/pendrive/iptv')
ap.add_argument('--conf', default=os.path.expanduser('~/iptv-rec/conf.json'))
ap.add_argument('--app', default=APP_ORIGIN, help='where the web app is fetched from (URL or local folder)')
ap.add_argument('--require-mount', default='/mnt/pendrive', help="refuse to record unless this is a mount point ('' to skip)")
ap.add_argument('--ffmpeg', default='ffmpeg')
args = ap.parse_args()

lock = threading.RLock()
recs = {}          # id → recording (persisted in DATA/recs.json, without credentials)
workers = {}       # id → Worker
accounts = {}      # account key → {server, username, password} (persisted in CONF, mode 600)
sync = {'rev': 0, 'keys': {}}   # app data shared by the screens: key → {'v': value, 'rev': n} (DATA/sync.json)
SYNC_KEY = re.compile(r'^[\w:|./@+-]{1,300}$')
SYNC_MAX = 4 * 1024**2


def log(*a):
    print(time.strftime('%Y-%m-%d %H:%M:%S'), *a, flush=True)


# ---------------------------------------------------------------- storage

def storage_ok():
    if args.require_mount and not os.path.ismount(args.require_mount):
        return False, f'El pendrive no está montado en {args.require_mount}'
    try:
        os.makedirs(args.data, exist_ok=True)
    except OSError as e:
        return False, f'No se puede escribir en {args.data}: {e}'
    return True, ''


def disk():
    try:
        u = shutil.disk_usage(args.data)
        return {'free': u.free, 'total': u.total}
    except OSError:
        return {'free': 0, 'total': 0}


def save_json(path, obj, private=False):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    if private:
        os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def load_state():
    global recs, accounts
    try:
        with open(args.conf) as f:
            accounts = json.load(f).get('accounts', {})
    except (OSError, ValueError):
        accounts = {}
    try:
        with open(os.path.join(args.data, 'recs.json')) as f:
            recs = {r['id']: r for r in json.load(f)}
    except (OSError, ValueError):
        recs = {}
    try:
        with open(os.path.join(args.data, 'sync.json')) as f:
            sync.update(json.load(f))
    except (OSError, ValueError):
        pass


def save_recs():
    ok, _ = storage_ok()
    if ok:
        save_json(os.path.join(args.data, 'recs.json'), list(recs.values()))


def save_sync():
    ok, _ = storage_ok()
    if ok:
        save_json(os.path.join(args.data, 'sync.json'), sync)


def save_accounts():
    os.makedirs(os.path.dirname(args.conf), exist_ok=True)
    save_json(args.conf, {'accounts': accounts}, private=True)


def rec_dir(rid):
    return os.path.join(args.data, 'rec', rid)


# ---------------------------------------------------------------- recording

def source_urls(acc, src, formats):
    u, p = urllib.parse.quote(acc['username'], safe=''), urllib.parse.quote(acc['password'], safe='')
    order = [f for f in ('ts', 'm3u8') if f in (formats or ['ts', 'm3u8'])] or ['ts', 'm3u8']
    return [(src, f, f"{acc['server'].rstrip('/')}/live/{u}/{p}/{src['id']}.{f}") for f in order]


def segments(part_dir):
    """[(duration, filename)] from a part's ffmpeg playlist."""
    out, dur = [], None
    try:
        with open(os.path.join(part_dir, 'index.m3u8')) as f:
            for line in f:
                line = line.strip()
                if line.startswith('#EXTINF:'):
                    dur = float(line[8:].split(',')[0] or 0)
                elif line and not line.startswith('#') and dur is not None:
                    out.append((dur, line))
                    dur = None
    except OSError:
        pass
    return out


def file_size(path):
    try:
        return os.path.getsize(path)
    except OSError:
        return 0


def dir_size(path):
    total = 0
    for root, _, files in os.walk(path):
        for n in files:
            try:
                total += os.path.getsize(os.path.join(root, n))
            except OSError:
                pass
    return total


class Worker(threading.Thread):
    """Records one programme until its end, switching sources when one fails or cuts out."""

    def __init__(self, rec):
        super().__init__(daemon=True)
        self.rec = rec
        self.stop_flag = threading.Event()
        self.proc = None

    def note(self, text):
        with lock:
            self.rec.setdefault('log', []).append([int(time.time()), text])
            self.rec['log'] = self.rec['log'][-50:]
            save_recs()
        log(self.rec['id'], text)

    def run(self):
        rec = self.rec
        acc = accounts.get(rec['account'])
        if not acc:
            return self.finish('failed', 'Faltan las credenciales de la cuenta')
        if not rec['sources']:
            return self.finish('failed', 'Sin canales')
        with lock:
            rec['state'] = 'recording'
            rec.setdefault('parts', [])
            save_recs()
        si = fi = 0          # current channel and format
        dry = 0              # consecutive attempts without any data
        while not self.stop_flag.is_set() and time.time() < rec['end']:
            ok, why = storage_ok()
            if not ok:
                return self.finish('failed', why)
            if disk()['free'] < MIN_FREE // 4:
                return self.finish('failed', 'Pendrive lleno')
            urls = source_urls(acc, rec['sources'][si], rec.get('formats'))
            src, fmt, url = urls[fi % len(urls)]
            got = self.record_part(src, fmt, url)
            if self.stop_flag.is_set() or time.time() >= rec['end']:
                break
            if got:
                # It was recording and got cut: go straight to the next channel.
                dry = 0
                si, fi = (si + 1) % len(rec['sources']), 0
            else:
                # Nothing came through: other format of the same channel, then the next channel.
                dry += 1
                fi += 1
                if fi >= len(urls):
                    si, fi = (si + 1) % len(rec['sources']), 0
            total = sum(len(source_urls(acc, s, rec.get('formats'))) for s in rec['sources'])
            if dry and dry % total == 0:
                self.note('Ningún canal responde; reintentando en 20 s')
                self.stop_flag.wait(20)
            else:
                self.stop_flag.wait(SWITCH_PAUSE)
        self.finish('done' if any(segments(os.path.join(rec_dir(rec['id']), p['dir'])) for p in rec['parts']) else 'failed',
                    'Terminada' if not self.stop_flag.is_set() else 'Detenida')

    def record_part(self, src, fmt, url):
        rec = self.rec
        with lock:
            n = len(rec['parts'])
            part = {'dir': f'p{n}', 'source': src['name'], 'format': fmt, 'start': int(time.time())}
            rec['parts'].append(part)
            save_recs()
        pdir = os.path.join(rec_dir(rec['id']), part['dir'])
        os.makedirs(pdir, exist_ok=True)
        cmd = [args.ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin',
               '-rw_timeout', str(STALL * 1_000_000), '-i', url,
               '-map', '0:v?', '-map', '0:a?', '-c', 'copy',
               '-f', 'hls', '-hls_time', '6', '-hls_list_size', '0',
               '-hls_segment_filename', os.path.join(pdir, 's%05d.ts'), os.path.join(pdir, 'index.m3u8')]
        self.note(f'Grabando de {src["name"]} ({fmt})')
        err = open(os.path.join(pdir, 'ffmpeg.log'), 'w')
        self.proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=err)
        started = last_change = time.time()
        last_count, reason = 0, ''
        while True:
            if self.proc.poll() is not None:
                reason = f'el canal se cortó (ffmpeg salió con {self.proc.returncode})'
                break
            if self.stop_flag.is_set() or time.time() >= rec['end']:
                reason = ''
                break
            count = len(segments(pdir))
            now = time.time()
            if count != last_count:
                last_count, last_change = count, now
            elif now - last_change > (FIRST_DATA if count == 0 else STALL):
                reason = 'sin datos nuevos' if count else 'no llega imagen'
                break
            time.sleep(2)
        if self.proc.poll() is None:
            self.proc.send_signal(signal.SIGINT)   # lets ffmpeg close the playlist cleanly
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        err.close()
        got = len(segments(pdir))
        with lock:
            part['end'] = int(time.time())
            part['segments'] = got
            if reason:
                part['error'] = reason
            save_recs()
        if reason:
            self.note(f'{src["name"]}: {reason}' + (f' tras {fmt_dur(time.time() - started)}' if got else ''))
        return got > 0

    def finish(self, state, text):
        with lock:
            self.rec['state'] = state
            if self.stop_flag.is_set():
                self.rec['stopped'] = True   # stopped by hand: its early end is no cut
            self.rec['size'] = dir_size(rec_dir(self.rec['id']))
            save_recs()
            workers.pop(self.rec['id'], None)
        self.note(text)


def fmt_dur(s):
    m = int(s // 60)
    return f'{m // 60} h {m % 60} min' if m >= 60 else f'{m} min' if m else f'{int(s)} s'


def scheduler():
    while True:
        now = time.time()
        with lock:
            for r in list(recs.values()):
                if r['state'] in ('scheduled', 'recording') and r['id'] not in workers:
                    if r['start'] <= now < r['end']:
                        w = Worker(r)
                        workers[r['id']] = w
                        w.start()
                    elif now >= r['end']:
                        r['state'] = 'done' if r.get('parts') else 'missed'
                        save_recs()
        time.sleep(3)


def playlist(r):
    """The parts of a recording joined into one HLS playlist (discontinuity between sources)."""
    lines, target = [], 1
    for i, p in enumerate(r.get('parts', [])):
        pdir = os.path.join(rec_dir(r['id']), p['dir'])
        segs = segments(pdir)
        # The tail of a cut ffmpeg is often truncated (0.3 s announced, broken timestamps): strict
        # players (Safari, TVs) stall on it. Drop a short last segment and any empty file.
        if segs and segs[-1][0] < 2 and (p.get('end') or r['state'] != 'recording'):
            segs = segs[:-1]
        segs = [(d, name) for d, name in segs if d > 0 and file_size(os.path.join(pdir, name)) > 0]
        if not segs:
            continue
        if lines:
            lines.append('#EXT-X-DISCONTINUITY')
        for d, name in segs:
            target = max(target, math.ceil(d))
            lines += [f'#EXTINF:{d:.3f},', f"{p['dir']}/{name}"]
    done = r['state'] != 'recording'
    head = ['#EXTM3U', '#EXT-X-VERSION:3', f'#EXT-X-TARGETDURATION:{target}', '#EXT-X-MEDIA-SEQUENCE:0',
            f"#EXT-X-PLAYLIST-TYPE:{'VOD' if done else 'EVENT'}"]
    return '\n'.join(head + lines + (['#EXT-X-ENDLIST'] if done else [])) + '\n'


def public(r):
    out = {k: v for k, v in r.items() if k != 'account'}
    # Cuts: the wall-clock time between the end of one part's video and the start of the next
    # (the stall, the switch, the new connection), plus a late start and an early end.
    # gaps: [[position in the recording (s), time lost (s)]]
    dur, gaps, prev_end = 0.0, [], None
    for p in r.get('parts', []):
        d = sum(x for x, _ in segments(os.path.join(rec_dir(r['id']), p['dir'])))
        if d <= 0:
            continue
        lost = p['start'] - (prev_end if prev_end is not None else r['start'])
        if lost > GAP_MIN:
            gaps.append([round(dur), round(lost)])
        prev_end = p['start'] + d
        dur += d
    if prev_end is not None and r['state'] == 'done' and not r.get('stopped'):
        lost = r['end'] - prev_end
        if lost > GAP_MIN:
            gaps.append([round(dur), round(lost)])
    out['duration'] = round(dur)
    out['gaps'] = gaps
    if r['state'] == 'recording':
        out['size'] = dir_size(rec_dir(r['id']))
        cur = r['parts'][-1]['source'] if r.get('parts') else ''
        out['current'] = cur
    return out


# ---------------------------------------------------------------- web app (proxied, cached)

app_cache = {}   # path → (time, status, ctype, body)


def fetch_app(path):
    now = time.time()
    hit = app_cache.get(path)
    if hit and now - hit[0] < 300:
        return hit[1:]
    if not args.app.startswith('http'):
        full = os.path.normpath(os.path.join(args.app, path or 'index.html'))
        if not full.startswith(os.path.abspath(args.app)) or not os.path.isfile(full):
            return 404, 'text/plain', b'not found'
        with open(full, 'rb') as f:
            body = f.read()
        return 200, guess_type(full), body
    try:
        with urllib.request.urlopen(args.app + path, timeout=15) as res:
            body = res.read()
            entry = (now, 200, res.headers.get('Content-Type') or guess_type(path), body)
    except urllib.error.HTTPError as e:
        entry = (now, e.code, 'text/plain', b'')
    except Exception:
        if hit:
            return hit[1:]     # offline: serve the last copy
        return 502, 'text/plain', b'No se pudo descargar la app'
    app_cache[path] = entry
    return entry[1:]


def guess_type(path):
    ext = path.rsplit('.', 1)[-1].lower()
    return {'html': 'text/html; charset=utf-8', 'js': 'text/javascript; charset=utf-8', 'css': 'text/css; charset=utf-8',
            'json': 'application/json', 'm3u8': 'application/vnd.apple.mpegurl', 'ts': 'video/mp2t',
            'svg': 'image/svg+xml', 'png': 'image/png'}.get(ext, 'application/octet-stream')


# ---------------------------------------------------------------- HTTP API

RID = re.compile(r'^[a-z0-9]{8,32}$')


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def send(self, code, body=b'', ctype='application/json', headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        try:
            return json.loads(self.rfile.read(n) or b'{}')
        except ValueError:
            return {}

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == '/api/status':
            ok, why = storage_ok()
            with lock:
                active = [r['id'] for r in recs.values() if r['state'] == 'recording']
            return self.send(200, {'ok': ok, 'error': why, 'version': VERSION, 'disk': disk(), 'now': time.time(), 'recording': active})
        if path == '/api/recs':
            with lock:
                return self.send(200, [public(r) for r in recs.values()])
        if path == '/api/sync':
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            try:
                since = int(q.get('since', ['0'])[0])
            except ValueError:
                since = 0
            with lock:
                if since > sync['rev']:
                    since = 0   # the store was reset: everything again
                keys = {k: e['v'] for k, e in sync['keys'].items() if e['rev'] > since}
                return self.send(200, {'rev': sync['rev'], 'keys': keys})
        m = re.match(r'^/rec/([a-z0-9]+)/(index\.m3u8|p\d+/s\d+\.ts)$', path)
        if m:
            with lock:
                r = recs.get(m[1])
            if not r:
                return self.send(404, {'error': 'no existe'})
            if m[2] == 'index.m3u8':
                return self.send(200, playlist(r), 'application/vnd.apple.mpegurl')
            return self.send_file(os.path.join(rec_dir(r['id']), m[2]))
        # Anything else: the web app.
        rel = path.lstrip('/')
        if rel.startswith('iptv/'):
            rel = rel[5:]
        if '..' in rel:
            return self.send(400, 'bad path', 'text/plain')
        code, ctype, body = fetch_app(rel)
        self.send(code, body, ctype, {'Cache-Control': 'no-cache'})

    def send_file(self, full):
        # Streamed in blocks: the first bytes leave at once instead of after reading the whole segment.
        try:
            f = open(full, 'rb')
        except OSError:
            return self.send(404, {'error': 'no existe'})
        with f:
            self.send_response(200)
            self.send_header('Content-Type', 'video/mp2t')
            self.send_header('Content-Length', str(os.fstat(f.fileno()).st_size))
            self.send_header('Cache-Control', 'max-age=86400')
            self.end_headers()
            if self.command == 'HEAD':
                return
            try:
                while True:
                    block = f.read(256 * 1024)
                    if not block:
                        break
                    self.wfile.write(block)
            except (BrokenPipeError, ConnectionResetError):
                pass   # the player jumped elsewhere

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == '/api/recs':
            b = self.body()
            ok, why = storage_ok()
            if not ok:
                return self.send(503, {'error': why})
            if disk()['free'] < MIN_FREE:
                return self.send(507, {'error': 'Queda poco espacio en el pendrive'})
            creds = b.get('creds') or {}
            if not all(creds.get(k) for k in ('server', 'username', 'password')):
                return self.send(400, {'error': 'Faltan credenciales'})
            try:
                start, end = int(b['start']), int(b['end'])
                sources = [{'id': str(s['id']), 'name': str(s.get('name') or s['id'])} for s in b['sources']][:10]
            except (KeyError, TypeError, ValueError):
                return self.send(400, {'error': 'Datos incompletos'})
            if end <= start or end <= time.time() or not sources:
                return self.send(400, {'error': 'Horario o canales no válidos'})
            key = creds['server'].rstrip('/') + '|' + creds['username']
            r = {'id': uuid.uuid4().hex[:12], 'title': str(b.get('title') or 'Grabación')[:200], 'start': start, 'end': end,
                 'sources': sources, 'prog': b.get('prog') if isinstance(b.get('prog'), (int, float)) else None, 'formats': [f for f in b.get('formats') or [] if f in ('ts', 'm3u8')],
                 'account': key, 'state': 'scheduled', 'created': int(time.time()), 'parts': [], 'log': []}
            with lock:
                accounts[key] = {'server': creds['server'].rstrip('/'), 'username': creds['username'], 'password': creds['password']}
                save_accounts()
                recs[r['id']] = r
                save_recs()
            log(r['id'], 'programada', r['title'], time.ctime(start), '→', time.ctime(end))
            return self.send(201, public(r))
        m = re.match(r'^/api/recs/([a-z0-9]+)/stop$', path)
        if m:
            with lock:
                w = workers.get(m[1])
                r = recs.get(m[1])
                if r and not w and r['state'] == 'scheduled':
                    del recs[m[1]]
                    save_recs()
            if w:
                w.stop_flag.set()
            return self.send(200, {'ok': True})
        self.send(404, {'error': 'no existe'})

    def do_PUT(self):
        if urllib.parse.urlparse(self.path).path == '/api/sync':
            if int(self.headers.get('Content-Length') or 0) > SYNC_MAX:
                return self.send(413, {'error': 'Demasiados datos'})
            ok, why = storage_ok()
            if not ok:
                return self.send(503, {'error': why})
            keys = self.body().get('keys')
            if not isinstance(keys, dict) or not all(isinstance(k, str) and SYNC_KEY.match(k) for k in keys):
                return self.send(400, {'error': 'Datos no válidos'})
            with lock:
                for k, v in keys.items():
                    if sync['keys'].get(k, {}).get('v', ...) == v:
                        continue
                    sync['rev'] += 1
                    sync['keys'][k] = {'v': v, 'rev': sync['rev']}
                save_sync()
                return self.send(200, {'rev': sync['rev']})
        m = re.match(r'^/api/recs/([a-z0-9]+)$', urllib.parse.urlparse(self.path).path)
        if not m:
            return self.send(404, {'error': 'no existe'})
        b = self.body()
        with lock:
            r = recs.get(m[1])
            if not r:
                return self.send(404, {'error': 'no existe'})
            if 'title' in b:
                r['title'] = str(b['title'])[:200]
            if 'end' in b:
                r['end'] = int(b['end'])
            if r['state'] == 'scheduled':
                if 'start' in b:
                    r['start'] = int(b['start'])
                if b.get('sources'):
                    r['sources'] = [{'id': str(s['id']), 'name': str(s.get('name') or s['id'])} for s in b['sources']][:10]
            save_recs()
            return self.send(200, public(r))

    def do_DELETE(self):
        m = re.match(r'^/api/recs/([a-z0-9]+)$', urllib.parse.urlparse(self.path).path)
        if not m or not RID.match(m[1]):
            return self.send(404, {'error': 'no existe'})
        with lock:
            w = workers.get(m[1])
        if w:
            w.stop_flag.set()
            w.join(20)
        with lock:
            recs.pop(m[1], None)
            save_recs()
        shutil.rmtree(rec_dir(m[1]), ignore_errors=True)
        self.send(200, {'ok': True})


def main():
    load_state()
    ok, why = storage_ok()
    log(f'recorder {VERSION} on :{args.port}, data {args.data}', '' if ok else f'(AVISO: {why})')
    threading.Thread(target=scheduler, daemon=True).start()
    ThreadingHTTPServer(('0.0.0.0', args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
