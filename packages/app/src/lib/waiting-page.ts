/**
 * What visitors without the dev cookie see: the same page as web/public/index.html (the static
 * front used before the site became dynamic), with its stylesheet inlined. Keep both in sync.
 */
export const WAITING_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kwazat</title>
<meta name="robots" content="noindex, nofollow">
<style>
:root{--bg:#fafaf7;--text:#1c1c1a;--muted:#5d5d57;--accent:#2f5d50}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--text:#ececE6;--muted:#a3a39b;--accent:#8cc4b2}}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--text);font:18px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:34rem}
h1{margin:0 0 .5rem;font-size:2.6rem;letter-spacing:-.02em}
.lead{font-size:1.25rem;margin:0 0 1rem;color:var(--text)}
p{color:var(--muted)}
.soon{color:var(--accent);font-weight:600;margin-top:2rem}
</style>
</head>
<body>
<main>
<h1>Kwazat</h1>
<p class="lead">Neutral, sourced fact sheets on anything.</p>
<p>Type a name, get the facts: convictions, ongoing cases, investigations, ownership and relations, each one linked to its sources.</p>
<p class="soon">Coming soon.</p>
</main>
</body>
</html>
`;
