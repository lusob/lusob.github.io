#!/usr/bin/env python3
"""Spanish TV guide (EPG_dobleM by davidmuma: Movistar+, DAZN, TDT…) reduced to a small JSON
the player matches by channel name. Run once a day (GitHub Actions) → iptv/epg.json.

Output: {updated, base, img: [pictures], ch: [{n: [names], p: [[start, minutes, title, picture?], …]}]}
start = minutes since `base` (unix s); the window is 6 h back to 4 days ahead.
picture: index in `img` (episodes of a series share theirs), each one shortened: "m<id>" Movistar+
(the app uses its 1920×1080 still), "o<n>" Orange TV poster, "s<path>" Sincroguía, or a URL.
"""
import gzip, json, re, sys, time, urllib.request
from datetime import datetime
from xml.etree import ElementTree as ET

SRC = 'https://raw.githubusercontent.com/davidmuma/EPG_dobleM/master/guiatv.xml.gz'
BACK, AHEAD = 6 * 3600, 4 * 86400
# "M+ LaLiga HD", "M+ LaLiga.TV", "M+ LaLiga 1080" → "M+ LaLiga"
SUFFIX = re.compile(r'(\.TV|\s+(SD|HD|FHD|UHD|4K|720|1080))$', re.I)
# Kodi colour tags in titles: "[COLOR gold]…[/COLOR]"
TAGS = re.compile(r'\[/?(COLOR|B|I)[^\]]*\]', re.I)
MOVISTAR = re.compile(r'^https?://www\.movistarplus\.es/recorte/n/\w+/([\w-]+)$')
SINCRO = 'https://cdn.sincroguia.tv/storage/'
ORANGE = re.compile(r'^https?://orangetv\.orange\.es/pc/api/rtv/v1/images/epg/VERTICAL/VERTICAL_(\d+)\.jpg$')


def image(p):
    """The programme's picture, shortened (see the module doc)."""
    i = p.find('icon')
    src = (i.get('src') or '').strip() if i is not None else ''
    if not src.startswith('http'):
        return ''
    m = MOVISTAR.match(src)
    if m:
        return 'm' + m.group(1)
    m = ORANGE.match(src)
    if m:
        return 'o' + m.group(1)
    return 's' + src[len(SINCRO):] if src.startswith(SINCRO) else src


def ts(s):
    return int(datetime.strptime(s.strip(), '%Y%m%d%H%M%S %z').timestamp())


def main(out):
    req = urllib.request.Request(SRC, headers={'User-Agent': 'Mozilla/5.0 (iptv-web epg)'})
    raw = gzip.decompress(urllib.request.urlopen(req, timeout=300).read())
    root = ET.fromstring(raw)
    now = int(time.time())
    base = (now - BACK) // 3600 * 3600
    end = now + AHEAD
    chans, order = {}, []
    imgs, img_idx = [], {}
    for c in root.iter('channel'):
        names = []
        for d in c.iter('display-name'):
            n = SUFFIX.sub('', (d.text or '').strip()).strip()
            if n and n not in names:
                names.append(n)
        cid = c.get('id')
        if cid and names and cid not in chans:
            chans[cid] = {'n': names, 'p': []}
            order.append(cid)
    for p in root.iter('programme'):
        ch = chans.get(p.get('channel'))
        if not ch:
            continue
        try:
            a, b = ts(p.get('start')), ts(p.get('stop'))
        except (TypeError, ValueError):
            continue
        if b <= base or a >= end or b <= a:
            continue
        titles = p.findall('title')
        t = next((x.text for x in titles if x.get('lang') == 'es'), None) or (titles[0].text if titles else '')
        t = TAGS.sub('', t or '').strip()
        row = [(a - base) // 60, max(1, (b - a) // 60), t]
        img = image(p)
        if img:
            if img not in img_idx:
                img_idx[img] = len(imgs)
                imgs.append(img)
            row.append(img_idx[img])
        ch['p'].append(row)
    out_ch = []
    for cid in order:
        ch = chans[cid]
        if ch['p']:
            ch['p'].sort()
            out_ch.append(ch)
    data = {'updated': now, 'source': 'github.com/davidmuma/EPG_dobleM', 'base': base, 'img': imgs, 'ch': out_ch}
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    print(f'{len(out_ch)} channels, {sum(len(c["p"]) for c in out_ch)} programmes → {out}')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'epg.json')
