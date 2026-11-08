<?php
// DOČASNÉ (2026-09-19): servíruje MILNIKY.md jako HTML pro čtení v prohlížeči
// bez ssh. Až nebude potřeba, soubor smazat. Žádné závislosti, jen tenhle soubor.
declare(strict_types=1);
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store');

$file = __DIR__ . '/' . (preg_match('/^[A-Z0-9-]+\.md$/', $_GET['f'] ?? '') ? $_GET['f'] : 'MILNIKY.md');
$src = @file_get_contents($file);
if ($src === false) { http_response_code(404); exit('not found'); }

function esc(string $s): string { return htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); }

function inline(string $s): string {
  $codes = [];
  $s = preg_replace_callback('/`([^`]+)`/', function ($m) use (&$codes) {
    $codes[] = '<code>' . esc($m[1]) . '</code>';
    return "\x00" . (count($codes) - 1) . "\x00";
  }, $s);
  $s = esc($s);
  $s = preg_replace('/\[([^\]]+)\]\(([^)\s]+)\)/', '<a href="$2">$1</a>', $s);
  $s = preg_replace('/\*\*(.+?)\*\*/s', '<strong>$1</strong>', $s);
  $s = preg_replace('/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/s', '<em>$1</em>', $s);
  $s = preg_replace('/(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])/s', '<em>$1</em>', $s);
  $s = str_replace('★', '<span class="star">★</span>', $s);
  return preg_replace_callback("/\x00(\d+)\x00/", fn($m) => $codes[(int)$m[1]], $s);
}

function render(string $src): string {
  $lines = preg_split('/\r?\n/', $src);
  $out = '';
  $n = count($lines);
  $i = 0;
  while ($i < $n) {
    $line = $lines[$i];
    if (trim($line) === '') { $i++; continue; }
    // blok kódu
    if (preg_match('/^\s*```/', $line)) {
      $buf = [];
      $i++;
      while ($i < $n && !preg_match('/^\s*```/', $lines[$i])) $buf[] = $lines[$i++];
      $i++;
      $out .= '<pre>' . esc(implode("\n", $buf)) . "</pre>\n";
      continue;
    }
    if (preg_match('/^\s*(-{3,}|\*{3,})\s*$/', $line)) { $out .= "<hr>\n"; $i++; continue; }
    if (preg_match('/^(#{1,6})\s+(.*)$/', $line, $m)) {
      $lvl = strlen($m[1]);
      $text = $m[2];
      $id = strtolower(preg_replace('/[^a-z0-9]+/i', '-', preg_replace('/[*`]/', '', $text)));
      $out .= "<h$lvl id=\"" . esc(trim($id, '-')) . "\">" . inline($text) . "</h$lvl>\n";
      $i++;
      continue;
    }
    // tabulka
    if (preg_match('/^\s*\|/', $line) && $i + 1 < $n && preg_match('/^\s*\|?\s*:?-+/', $lines[$i + 1])) {
      $rows = [];
      while ($i < $n && preg_match('/^\s*\|/', $lines[$i])) $rows[] = $lines[$i++];
      $cells = fn($r) => array_map('trim', explode('|', preg_replace('/^\s*\||\|\s*$/', '', $r)));
      $out .= "<table>\n<thead><tr>";
      foreach ($cells($rows[0]) as $c) $out .= '<th>' . inline($c) . '</th>';
      $out .= "</tr></thead>\n<tbody>\n";
      for ($r = 2; $r < count($rows); $r++) {
        $out .= '<tr>';
        foreach ($cells($rows[$r]) as $c) $out .= '<td>' . inline($c) . '</td>';
        $out .= "</tr>\n";
      }
      $out .= "</tbody></table>\n";
      continue;
    }
    // citace
    if (preg_match('/^\s*>/', $line)) {
      $buf = [];
      while ($i < $n && preg_match('/^\s*>\s?(.*)$/', $lines[$i], $m)) { $buf[] = $m[1]; $i++; }
      $out .= '<blockquote>' . render(implode("\n", $buf)) . "</blockquote>\n";
      continue;
    }
    // seznam (odrážky i číslované, vnořené podle odsazení)
    if (preg_match('/^(\s*)([-*]|\d+[.)])\s+/', $line)) {
      $out .= renderList($lines, $i, $n);
      continue;
    }
    // odstavec
    $buf = [];
    while ($i < $n && trim($lines[$i]) !== ''
        && !preg_match('/^(#{1,6}\s|\s*```|\s*(-{3,}|\*{3,})\s*$|\s*\||\s*>|\s*([-*]|\d+[.)])\s+)/', $lines[$i])) {
      $buf[] = trim($lines[$i]);
      $i++;
    }
    if ($buf) $out .= '<p>' . inline(implode("\n", $buf)) . "</p>\n";
    else $i++;
  }
  return $out;
}

function renderList(array $lines, int &$i, int $n): string {
  preg_match('/^(\s*)([-*]|\d+[.)])\s+/', $lines[$i], $m);
  $indent = strlen($m[1]);
  $ordered = ctype_digit($m[2][0]);
  $tag = $ordered ? 'ol' : 'ul';
  $out = "<$tag>\n";
  while ($i < $n) {
    $line = $lines[$i];
    if (trim($line) === '') {
      // prázdný řádek: seznam pokračuje, jen když další neprázdný řádek je zase položka/odsazení
      $j = $i;
      while ($j < $n && trim($lines[$j]) === '') $j++;
      if ($j < $n && preg_match('/^(\s*)/', $lines[$j], $w) && strlen($w[1]) >= $indent
          && (preg_match('/^\s*([-*]|\d+[.)])\s+/', $lines[$j]) || strlen($w[1]) > $indent)) { $i = $j; continue; }
      break;
    }
    if (!preg_match('/^(\s*)([-*]|\d+[.)])\s+(.*)$/', $line, $m)) break;
    $ind = strlen($m[1]);
    if ($ind < $indent) break;
    if ($ind > $indent) { $out .= renderList($lines, $i, $n); continue; }
    $text = $m[3];
    $i++;
    // pokračovací řádky položky (odsazené, ne nová položka)
    $sub = '';
    while ($i < $n) {
      $l = $lines[$i];
      if (trim($l) === '') {
        $j = $i; while ($j < $n && trim($lines[$j]) === '') $j++;
        if ($j < $n && preg_match('/^(\s*)/', $lines[$j], $w) && strlen($w[1]) > $indent
            && !preg_match('/^\s*([-*]|\d+[.)])\s+/', $lines[$j])) { $text .= "\n"; $i = $j; continue; }
        break;
      }
      if (preg_match('/^(\s*)([-*]|\d+[.)])\s+/', $l, $w)) {
        if (strlen($w[1]) > $indent) { $sub .= renderList($lines, $i, $n); continue; }
        break;
      }
      if (preg_match('/^(\s*)/', $l, $w) && strlen($w[1]) > $indent) { $text .= "\n" . trim($l); $i++; continue; }
      break;
    }
    $cls = '';
    if (preg_match('/^\[([ xX])\]\s*(.*)$/s', $text, $c)) {
      $cls = $c[1] === ' ' ? ' class="todo"' : ' class="done"';
      $text = ($c[1] === ' ' ? '☐ ' : '☑ ') . $c[2];
    }
    $out .= "<li$cls>" . inline($text) . $sub . "</li>\n";
  }
  return $out . "</$tag>\n";
}

$title = preg_match('/^#\s+(.*)$/m', $src, $m) ? preg_replace('/[*`]/', '', $m[1]) : basename($file);
?>
<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title><?= esc($title) ?></title>
<style>
  :root { color-scheme: light dark; --fg: #222; --bg: #fff; --muted: #666; --line: #ddd; --code: #f3f3f3; --link: #0a58ca; --star: #b8860b; }
  @media (prefers-color-scheme: dark) { :root { --fg: #ddd; --bg: #1a1a1a; --muted: #999; --line: #444; --code: #2a2a2a; --link: #7ab4ff; --star: #f0c040; } }
  html { background: var(--bg); color: var(--fg); }
  body { max-width: 52em; margin: 0 auto; padding: 1em 1.2em 4em; font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  h1, h2, h3, h4 { line-height: 1.25; margin: 1.6em 0 .5em; }
  h1 { font-size: 1.8em; border-bottom: 2px solid var(--line); padding-bottom: .3em; }
  h2 { font-size: 1.4em; border-bottom: 1px solid var(--line); padding-bottom: .2em; }
  h3 { font-size: 1.15em; }
  a { color: var(--link); }
  code, pre { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: .92em; }
  code { background: var(--code); padding: .05em .3em; border-radius: 3px; white-space: nowrap; }
  pre { background: var(--code); padding: .8em 1em; overflow-x: auto; border-radius: 4px; }
  pre code { background: none; padding: 0; white-space: pre; }
  table { border-collapse: collapse; margin: 1em 0; width: 100%; }
  th, td { border: 1px solid var(--line); padding: .35em .6em; text-align: left; vertical-align: top; }
  th { background: var(--code); }
  ul, ol { padding-left: 1.6em; }
  li { margin: .25em 0; white-space: pre-line; }
  li.done { color: var(--muted); }
  li.done > strong { color: var(--fg); }
  blockquote { border-left: 4px solid var(--line); margin: 1em 0; padding: 0 1em; color: var(--muted); }
  hr { border: 0; border-top: 1px solid var(--line); margin: 2em 0; }
  .star { color: var(--star); }
  .meta { color: var(--muted); font-size: .85em; }
</style>
</head>
<body>
<p class="meta"><?= esc(basename($file)) ?> · <?= date('Y-m-d H:i', filemtime($file)) ?></p>
<?= render($src) ?>
</body>
</html>
