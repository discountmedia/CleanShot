"""
Convert README.md to a standalone README.html with a sticky-sidebar TOC.

Run from the repo root:
    python scripts/build_readme_html.py

No external runtime dependencies beyond `python -m pip install --user
markdown pygments`. The output is self-contained — all CSS + the tiny
scroll-spy script are embedded so the HTML file can be emailed / dropped
into Drive without breaking.
"""

from __future__ import annotations

import re
from pathlib import Path

import markdown


def build() -> None:
    md_text = Path("README.md").read_text(encoding="utf-8")

    md_processor = markdown.Markdown(
        extensions=["extra", "codehilite", "toc", "sane_lists", "smarty"],
        extension_configs={
            "codehilite": {"css_class": "codehilite", "guess_lang": False},
            "toc":        {"anchorlink": False, "permalink": False, "toc_depth": "2-3"},
        },
        output_format="html5",
    )

    html_body = md_processor.convert(md_text)
    toc_html = md_processor.toc  # auto-generated <div class="toc"><ul>...</ul></div>

    # Strip the hand-written Table of Contents heading + its following <ul>
    # from the body — the sticky sidebar replaces it. count=1 so we only
    # nuke the first match (the actual TOC), not any other <ul> that
    # happens to follow an <h2> by coincidence later in the doc.
    html_body = re.sub(
        r'<h2 id="table-of-contents">.*?</h2>\s*<ul>.*?</ul>',
        "",
        html_body,
        count=1,
        flags=re.DOTALL,
    )

    # The auto-generated sidebar TOC includes the now-orphaned
    # "Table of Contents" entry as its first <li> (the h2 still had id=
    # "table-of-contents" when toc was generated). It would 404-jump to
    # nothing, and besides — the sidebar IS the table of contents, so
    # an entry called that is just noise. Strip the first <li> if it
    # points at #table-of-contents.
    toc_html = re.sub(
        r'<li>\s*<a href="#table-of-contents">[^<]*</a>\s*</li>\s*',
        "",
        toc_html,
        count=1,
    )

    css = CSS
    spy = SCROLL_SPY
    html = SHELL.format(css=css, toc=toc_html, body=html_body, spy=spy)
    Path("README.html").write_text(html, encoding="utf-8")
    print(f"wrote README.html ({len(html):,} bytes)")


CSS = r"""
:root {
  --bg: #ffffff;
  --bg-soft: #f7f8fa;
  --border: #e3e6ea;
  --border-soft: #eef0f3;
  --text: #1f2328;
  --text-soft: #57606a;
  --text-dim: #8c959f;
  --link: #0969da;
  --link-hover: #0860c7;
  --accent: #0969da;
  --code-bg: #f4f5f7;
  --code-text: #1f2328;
  --table-stripe: #f9fafb;
  --shadow: 0 1px 2px rgba(31, 35, 40, 0.04);
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --bg-soft: #161b22;
    --border: #30363d;
    --border-soft: #21262d;
    --text: #e6edf3;
    --text-soft: #9198a1;
    --text-dim: #6e7681;
    --link: #4493f8;
    --link-hover: #58a6ff;
    --accent: #4493f8;
    --code-bg: #161b22;
    --code-text: #e6edf3;
    --table-stripe: #161b22;
    --shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
  }
}

* { box-sizing: border-box; }
html {
  -webkit-text-size-adjust: 100%;
  scroll-behavior: smooth;
  scroll-padding-top: 24px;
}

body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif;
  font-size: 16px;
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

/* Sticky-sidebar layout */
.layout {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  gap: 48px;
  max-width: 1240px;
  margin: 0 auto;
  padding: 32px 32px 96px;
}

.sidebar {
  position: sticky;
  top: 32px;
  align-self: start;
  max-height: calc(100vh - 64px);
  overflow-y: auto;
  padding-right: 12px;
  border-right: 1px solid var(--border-soft);
}

.sidebar::-webkit-scrollbar { width: 8px; }
.sidebar::-webkit-scrollbar-track { background: transparent; }
.sidebar::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 4px;
}
.sidebar::-webkit-scrollbar-thumb:hover { background: var(--text-dim); }

.sidebar-title {
  font-size: 0.72em;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: var(--text-dim);
  margin: 0 0 14px 8px;
  font-weight: 700;
}

.sidebar .toc > ul,
.sidebar nav.toc > ul {
  list-style: none;
  padding: 0;
  margin: 0;
  font-size: 0.88em;
}

.sidebar .toc ul ul,
.sidebar nav.toc ul ul {
  list-style: none;
  padding-left: 12px;
  margin: 2px 0 6px 8px;
  border-left: 1px solid var(--border-soft);
}

.sidebar .toc li,
.sidebar nav.toc li { margin: 1px 0; }

.sidebar .toc a,
.sidebar nav.toc a {
  color: var(--text-soft);
  display: block;
  padding: 4px 10px;
  border-radius: 5px;
  text-decoration: none;
  line-height: 1.4;
  transition: background 120ms, color 120ms;
}

.sidebar .toc a:hover,
.sidebar nav.toc a:hover {
  background: var(--bg-soft);
  color: var(--link);
}

.main { min-width: 0; }

@media (max-width: 960px) {
  .layout {
    grid-template-columns: 1fr;
    gap: 0;
    padding: 24px 18px 64px;
  }
  .sidebar {
    position: static;
    max-height: none;
    border-right: none;
    border-bottom: 1px solid var(--border-soft);
    padding: 0 0 20px;
    margin-bottom: 24px;
  }
  .sidebar-title { margin-left: 0; }
}

/* Typography */
h1, h2, h3, h4, h5, h6 {
  margin-top: 2em;
  margin-bottom: 0.6em;
  line-height: 1.25;
  font-weight: 600;
  color: var(--text);
}

h1 {
  font-size: 2.25em;
  border-bottom: 1px solid var(--border);
  padding-bottom: 0.4em;
  margin-top: 0;
}

h2 {
  font-size: 1.55em;
  border-bottom: 1px solid var(--border-soft);
  padding-bottom: 0.3em;
}

h3 { font-size: 1.22em; }
h4 { font-size: 1.05em; }

p { margin: 0.85em 0; }

a { color: var(--link); text-decoration: none; }
a:hover { color: var(--link-hover); text-decoration: underline; }

ul, ol { padding-left: 1.6em; margin: 0.85em 0; }
li { margin: 0.25em 0; }
li > p { margin: 0.4em 0; }

hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 2.5em 0;
}

blockquote {
  margin: 1em 0;
  padding: 0.6em 1.1em;
  border-left: 4px solid var(--accent);
  background: var(--bg-soft);
  color: var(--text-soft);
  border-radius: 0 6px 6px 0;
}

blockquote p:first-child { margin-top: 0; }
blockquote p:last-child  { margin-bottom: 0; }

strong { font-weight: 600; color: var(--text); }
em { font-style: italic; }

code {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 0.88em;
  background: var(--code-bg);
  color: var(--code-text);
  padding: 0.18em 0.4em;
  border-radius: 4px;
  border: 1px solid var(--border-soft);
}

pre {
  background: var(--code-bg);
  color: var(--code-text);
  padding: 16px 18px;
  border-radius: 8px;
  border: 1px solid var(--border-soft);
  overflow-x: auto;
  margin: 1em 0;
  box-shadow: var(--shadow);
  font-size: 0.86em;
  line-height: 1.55;
}

pre code {
  background: transparent;
  border: none;
  padding: 0;
  font-size: inherit;
  color: inherit;
}

table {
  border-collapse: collapse;
  width: 100%;
  margin: 1.2em 0;
  font-size: 0.94em;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  box-shadow: var(--shadow);
}

thead { background: var(--bg-soft); }

th, td {
  padding: 9px 14px;
  text-align: left;
  border-bottom: 1px solid var(--border-soft);
  vertical-align: top;
}

th {
  font-weight: 600;
  color: var(--text);
  border-bottom: 2px solid var(--border);
}

tbody tr:nth-child(even) { background: var(--table-stripe); }
tbody tr:last-child td { border-bottom: none; }
tbody td code { font-size: 0.85em; }

img { max-width: 100%; height: auto; border-radius: 6px; }

.codehilite { background: var(--code-bg); border-radius: 8px; overflow: hidden; margin: 1em 0; }
.codehilite pre { margin: 0; border: 1px solid var(--border-soft); border-radius: 8px; }

.cover {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.cover-meta {
  color: var(--text-dim);
  font-size: 0.85em;
  font-family: ui-monospace, SFMono-Regular, monospace;
}

.cover-meta strong { color: var(--text-soft); font-weight: 500; }

.banner {
  background: linear-gradient(135deg, rgba(9, 105, 218, 0.08) 0%, rgba(9, 105, 218, 0.02) 100%);
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  padding: 16px 20px;
  margin: 18px 0 28px;
  font-size: 0.95em;
  color: var(--text-soft);
}

@media (prefers-color-scheme: dark) {
  .banner {
    background: linear-gradient(135deg, rgba(68, 147, 248, 0.10) 0%, rgba(68, 147, 248, 0.03) 100%);
  }
}

/* Pygments tokens */
.codehilite .c, .codehilite .c1, .codehilite .cm { color: #6a737d; font-style: italic; }
.codehilite .k, .codehilite .kn, .codehilite .kd { color: #d73a49; font-weight: 600; }
.codehilite .s, .codehilite .s1, .codehilite .s2 { color: #032f62; }
.codehilite .n, .codehilite .nv { color: var(--text); }
.codehilite .nf, .codehilite .nc { color: #6f42c1; font-weight: 600; }
.codehilite .mi, .codehilite .mf { color: #005cc5; }
.codehilite .o { color: #d73a49; }
.codehilite .p { color: var(--text-soft); }

@media (prefers-color-scheme: dark) {
  .codehilite .c, .codehilite .c1, .codehilite .cm { color: #8b949e; }
  .codehilite .k, .codehilite .kn, .codehilite .kd { color: #ff7b72; }
  .codehilite .s, .codehilite .s1, .codehilite .s2 { color: #a5d6ff; }
  .codehilite .nf, .codehilite .nc { color: #d2a8ff; }
  .codehilite .mi, .codehilite .mf { color: #79c0ff; }
  .codehilite .o { color: #ff7b72; }
}

/* Scroll-spy active state on sidebar TOC links */
.sidebar .toc a.is-active,
.sidebar nav.toc a.is-active {
  background: rgba(9, 105, 218, 0.10);
  color: var(--link);
  font-weight: 600;
}

@media (prefers-color-scheme: dark) {
  .sidebar .toc a.is-active,
  .sidebar nav.toc a.is-active {
    background: rgba(68, 147, 248, 0.15);
  }
}
"""


SCROLL_SPY = r"""
<script>
(function() {
  var links = Array.prototype.slice.call(
    document.querySelectorAll('.sidebar .toc a, .sidebar nav.toc a')
  );
  if (!links.length) return;

  var pairs = links
    .map(function(a) {
      var href = a.getAttribute('href') || '';
      if (href.charAt(0) !== '#') return null;
      var t = document.querySelector(href);
      return t ? { link: a, target: t } : null;
    })
    .filter(Boolean);
  if (!pairs.length) return;

  var setActive = function(id) {
    links.forEach(function(l) {
      l.classList.toggle('is-active', l.getAttribute('href') === '#' + id);
    });
  };

  var io = new IntersectionObserver(function(entries) {
    var visible = entries
      .filter(function(e) { return e.isIntersecting; })
      .sort(function(a, b) {
        return a.boundingClientRect.top - b.boundingClientRect.top;
      });
    if (visible.length) setActive(visible[0].target.id);
  }, { rootMargin: '-10% 0px -75% 0px', threshold: 0 });

  pairs.forEach(function(p) { io.observe(p.target); });
})();
</script>
"""


SHELL = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="CleanShot — AI-powered forklift image processing platform. Internal B2B tool for Discount Forklift.">
  <title>CleanShot — Project Documentation</title>
  <style>{css}</style>
</head>
<body>
  <div class="layout">
    <aside class="sidebar">
      <p class="sidebar-title">Contents</p>
      {toc}
    </aside>
    <main class="main">
      <div class="cover">
        <span class="cover-meta"><strong>Internal documentation</strong> · Discount Forklift</span>
      </div>
      <div class="banner">
        This is the standalone HTML snapshot of <code>README.md</code> from the CleanShot repository. Generated for sharing; the canonical source lives in the private GitHub repo.
      </div>
      {body}
    </main>
  </div>
  {spy}
</body>
</html>
"""


if __name__ == "__main__":
    build()
