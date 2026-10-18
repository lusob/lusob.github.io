"""Sports agenda for the app: futbolenlatv.es/deporte → agenda.json.

Usage: python3 agenda.py OUT.json [SAVED_PAGE.html]
Run once a day (GitHub Actions, .github/workflows/agenda.yml in lusob.github.io).
"""
import html, json, re, sys, time, urllib.request
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

URL = 'https://www.futbolenlatv.es/deporte'
MADRID = ZoneInfo('Europe/Madrid')
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36'


def text(s):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', s or ''))).strip()


def attr(s, pattern):
    m = re.search(pattern, s, re.S)
    return html.unescape(m.group(1)).strip() if m else ''


def duration(s):
    m = re.match(r'T(?:(\d+)H)?(?:(\d+)M)?', s or '')
    return (int(m.group(1) or 0) * 60 + int(m.group(2) or 0)) if m and (m.group(1) or m.group(2)) else 120


def parse(page):
    events, day = [], None
    for row in re.findall(r'<tr[^>]*>(.*?)</tr>', page, re.S):
        head = re.search(r'class="cabeceraTabla[^"]*"|(\d{2})/(\d{2})/(\d{4})', row)
        if 'cabeceraTabla' in row or (head and '<td class="hora' not in row):
            m = re.search(r'(\d{2})/(\d{2})/(\d{4})', row)
            if m:
                day = datetime(int(m.group(3)), int(m.group(2)), int(m.group(1)), tzinfo=MADRID)
            continue
        hm = re.search(r'<td class="hora[^"]*">\s*(\d{1,2}):(\d{2})', row)
        if not hm or day is None:
            continue
        start = day.replace(hour=int(hm.group(1)), minute=int(hm.group(2)))
        det = attr(row, r'<td class="detalles[^"]*">(.*?)</td>')
        sport = attr(det, r'<img [^>]*\balt="([^"]*)"')
        comp = attr(det, r'<label title="([^"]*)"')
        stage = attr(det, r'</a>\s*<span title="([^"]*)"')
        home = attr(row, r'<td class="local[^"]*">.*?<span title="([^"]*)"')
        away = attr(row, r'<td class="visitante[^"]*">.*?<span title="([^"]*)"')
        # Crests: "https://static.futbolenlatv.com/img/32/20140812072902-deportivo-merlo.webp" → its name
        crest = lambda cls: attr(row, r'<td class="' + cls + r'[^"]*">(?:(?!</td>).)*?<img [^>]*\bsrc="https?://static\.futbolenlatv\.com/img/32/([\w.-]+?)\.(?:webp|png)"')
        single = text(attr(row, r'<span class="eventoUnico">(.*?)</span>'))
        # Every channel of the list, linked ones too ("LALIGA TV Hypermotion (M56 O120): VER PARTIDO")
        lst = attr(row, r'<ul class="listaCanales">(.*?)</ul>')
        chans = []
        for c in re.findall(r'<li\b[^>]*\btitle="([^"]*)"', lst):
            c = re.sub(r'\s*:\s*ver\b.*$|\(\s*ver\b[^)]*\)', '', html.unescape(c), flags=re.I).strip()
            # A bare "DAZN (Ver en directo)" is an advert for the app, not a channel
            if c and c.upper() != 'DAZN' and c not in chans:
                chans.append(c)
        if not (home or single) or not chans:
            continue
        ev = {'t': int(start.timestamp()), 'dur': duration(attr(row, r'itemprop="duration" content="([^"]*)"')),
              'sport': sport, 'comp': comp, 'channels': chans}
        if stage:
            ev['stage'] = stage
        if home:
            ev['home'], ev['away'] = home, away
            hi, ai = crest('local'), crest('visitante')
            if hi:
                ev['hi'] = hi
            if ai:
                ev['ai'] = ai
        else:
            ev['title'] = single
        events.append(ev)
    events.sort(key=lambda e: e['t'])
    return events


def main():
    if len(sys.argv) > 2:
        page = open(sys.argv[2], encoding='utf-8').read()
    else:
        req = urllib.request.Request(URL, headers={'User-Agent': UA, 'Accept-Language': 'es-ES,es;q=0.9'})
        page = urllib.request.urlopen(req, timeout=60).read().decode('utf-8', 'replace')
    events = parse(page)
    if len(events) < 10:
        sys.exit(f'Only {len(events)} events: the page layout may have changed')
    out = {'updated': int(time.time()), 'source': URL, 'events': events}
    with open(sys.argv[1], 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print(f'{len(events)} events')


if __name__ == '__main__':
    main()
