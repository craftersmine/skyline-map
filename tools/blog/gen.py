"""Writes blog/*.html, public/blog/feed.xml and public/sitemap.xml from tools/blog/posts.py. Run: python3 tools/blog/gen.py"""
import json, html, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from posts import POSTS, DATE, DATE_H

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..') + '/'
SITE = 'https://skyline.codz.me'
MAN = json.load(open(ROOT + 'public/showcase/manifest.json'))
os.makedirs(ROOT + 'blog', exist_ok=True)
e = html.escape


def img_url(shot):
    return f"{SITE}/showcase/{shot}-{MAN[shot]['widths'][-1]}.webp"


def head(title, desc, url, image, ld, og_type='article'):
    return f'''<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>{e(title)}</title>
  <meta name="description" content="{e(desc)}" />
  <link rel="canonical" href="{url}" />
  <meta name="theme-color" content="#1a73e8" />
  <meta name="color-scheme" content="light" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="alternate" type="application/rss+xml" title="Skyline Map blog" href="/blog/feed.xml" />
  <meta property="og:type" content="{og_type}" />
  <meta property="og:site_name" content="Skyline Map" />
  <meta property="og:title" content="{e(title)}" />
  <meta property="og:description" content="{e(desc)}" />
  <meta property="og:url" content="{url}" />
  <meta property="og:image" content="{image}" />
  <meta property="og:locale" content="en_US" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="{e(title)}" />
  <meta name="twitter:description" content="{e(desc)}" />
  <meta name="twitter:image" content="{image}" />
  <script type="application/ld+json">{json.dumps(ld, ensure_ascii=False)}</script>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cpath fill='%231a73e8' d='M16 2C10.5 2 6 6.4 6 11.9 6 19.3 16 30 16 30s10-10.7 10-18.1C26 6.4 21.5 2 16 2z'/%3E%3Ccircle cx='16' cy='12' r='4' fill='white'/%3E%3C/svg%3E" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Chivo+Mono:wght@500;700;800&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/src/showcase/showcase.css" />
  <link rel="stylesheet" href="/src/blog/blog.css" />
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <header class="top blog-top">
    <div class="top-in">
      <a class="mark" href="/"><span class="mark-pin" aria-hidden="true"></span>Skyline Map</a>
      <nav aria-label="Site"><a href="/blog/"{' aria-current="page"' if url.endswith('/blog/') else ''}>Blog</a><a href="/showcase">Tour</a></nav>
      <a class="btn btn-primary btn-sm" href="/">Open your export</a>
    </div>
  </header>
'''


FOOT = '''  <footer class="foot">
    <div class="container foot-in">
      <a class="mark" href="/"><span class="mark-pin" aria-hidden="true"></span>Skyline Map</a>
      <p>A free map viewer for Cities: Skylines CSLMapView exports. Screenshots are the live app; place names in them are shown in English.</p>
      <nav aria-label="Footer"><a href="/">Open the app</a><a href="/blog/">Blog</a><a href="/showcase">Tour</a></nav>
    </div>
  </footer>
</body>
</html>
'''

PUBLISHER = {"@type": "Organization", "name": "Skyline Map", "url": SITE + "/", "logo": {"@type": "ImageObject", "url": SITE + "/icon-512.png"}}


def card(p, tag='h2', sizes='(min-width: 50rem) 300px, 100vw'):
    return f'''<li><a class="card" href="/blog/{p['slug']}">
          <img data-shot="{p['shot']}" data-sizes="{sizes}" alt="" />
          <div class="card-body"><{tag}>{e(p['title'])}</{tag}><p>{e(p['desc'])}</p></div>
        </a></li>'''


for i, p in enumerate(POSTS):
    url = f"{SITE}/blog/{p['slug']}"
    ld = [
        {"@context": "https://schema.org", "@type": "BlogPosting", "@id": url + "#post", "mainEntityOfPage": url, "headline": p['title'],
         "description": p['desc'], "image": img_url(p['shot']), "datePublished": DATE, "dateModified": DATE, "inLanguage": "en",
         "author": PUBLISHER, "publisher": PUBLISHER, "about": {"@type": "VideoGame", "name": "Cities: Skylines"},
         "isPartOf": {"@type": "Blog", "@id": SITE + "/blog/#blog", "name": "Skyline Map blog", "url": SITE + "/blog/"}},
        {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Skyline Map", "item": SITE + "/"},
            {"@type": "ListItem", "position": 2, "name": "Blog", "item": SITE + "/blog/"},
            {"@type": "ListItem", "position": 3, "name": p['short'], "item": url}]},
    ]
    related = [POSTS[(i + k) % len(POSTS)] for k in (1, 2)]
    page = head(p['title'], p['desc'], url, img_url(p['shot']), ld) + f'''
  <main id="main" class="container post">
    <article>
      <nav class="crumbs" aria-label="Breadcrumb"><a href="/blog/">Blog</a> / {e(p['short'])}</nav>
      <h1>{e(p['title'])}</h1>
      <p class="lead">{e(p['lead'])}</p>
      <p class="meta"><time datetime="{DATE}">{DATE_H}</time></p>
      <div class="prose">{p['body'].rstrip()}
      </div>
    </article>
    <aside class="cta" aria-labelledby="cta-h">
      <h2 id="cta-h">Open your city as a map.</h2>
      <p>Free, in your browser. Your file is read on your computer and never uploaded.</p>
      <a class="btn btn-primary" href="/">Open your export</a>
    </aside>
    <aside class="related" aria-labelledby="rel-h">
      <h2 id="rel-h">More guides</h2>
      <ul class="related-list">
        {''.join(card(r, 'h3', '(min-width: 50rem) 360px, 100vw') for r in related)}
      </ul>
    </aside>
  </main>
''' + FOOT
    open(ROOT + f"blog/{p['slug']}.html", 'w').write(page)

# index
url = SITE + '/blog/'
title = 'Skyline Map blog: guides for Cities: Skylines maps'
desc = 'Guides to mapping your Cities: Skylines city: exporting with CSLMapView, finding your files, transit maps, directions, tolls and fares, and what an export contains.'
ld = {"@context": "https://schema.org", "@type": "Blog", "@id": url + "#blog", "url": url, "name": "Skyline Map blog", "description": desc, "inLanguage": "en", "publisher": PUBLISHER,
      "blogPost": [{"@type": "BlogPosting", "headline": p['title'], "url": f"{SITE}/blog/{p['slug']}", "datePublished": DATE, "image": img_url(p['shot'])} for p in POSTS]}
page = head(title, desc, url, SITE + '/og-image.jpg', ld, 'website') + f'''
  <main id="main" class="container post">
    <h1>Guides</h1>
    <p class="lead">How to turn a Cities: Skylines save into a real map, and how to get the most out of it.</p>
    <ul class="posts">
      {''.join(card(p) for p in POSTS)}
    </ul>
  </main>
''' + FOOT
open(ROOT + 'blog/index.html', 'w').write(page)

# RSS feed (public/, copied as-is)
items = ''.join(f'''
    <item><title>{e(p['title'])}</title><link>{SITE}/blog/{p['slug']}</link><guid>{SITE}/blog/{p['slug']}</guid><pubDate>Mon, 09 Nov 2026 00:00:00 GMT</pubDate><description>{e(p['desc'])}</description></item>''' for p in POSTS)
os.makedirs(ROOT + 'public/blog', exist_ok=True)
open(ROOT + 'public/blog/feed.xml', 'w').write(f'''<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Skyline Map blog</title><link>{SITE}/blog/</link><description>{e(desc)}</description><language>en</language>{items}
  </channel>
</rss>
''')

# sitemap
urls = [(SITE + '/', '1.0', ['og-image.jpg']), (SITE + '/showcase', '0.8', ['showcase/d-hero-2400.webp', 'showcase/d-3d-buildings-2400.webp', 'showcase/d-schem-2400.webp', 'showcase/d-transit-2400.webp', 'showcase/d-terrain-3d-2400.webp']),
        (SITE + '/blog/', '0.7', [])] + [(f"{SITE}/blog/{p['slug']}", '0.7', [img_url(p['shot'])[len(SITE) + 1:]]) for p in POSTS]
body = ''.join(f'''
  <url>
    <loc>{u}</loc>
    <lastmod>{DATE}</lastmod>
    <priority>{pr}</priority>{''.join(f"{chr(10)}    <image:image><image:loc>{SITE}/{im}</image:loc></image:image>" for im in ims)}
  </url>''' for u, pr, ims in urls)
open(ROOT + 'public/sitemap.xml', 'w').write(f'''<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">{body}
</urlset>
''')
print('ok', len(POSTS))
