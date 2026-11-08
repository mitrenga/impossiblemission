# Protokol workeru

Hlavní vlákno kreslí, worker drží svět. Zprávy jsou jediné, co je spojuje.

## Hlavní vlákno → worker

| zpráva | pole | co dělá |
|---|---|---|
| `init` | `seed`, `fortress`, `rooms`, ★ `speech` | založí svět a **seedovaný zdroj náhody**, a ze semínka **vylosuje pevnost** rutinou originálu; odpoví `ready`. `fortress` je rozparsovaný `data/fortress.json`, `rooms` rozparsovaný `data/rooms.json` — stahování je věc volajícího, jako u `screenLoader.js` |
| `room` | `room` (0–31), `side` (0 zleva, 1 zprava) | **postaví místnost** stavitelem originálu (`$A39C`) ze záznamu vylosované pevnosti; odpoví `room` |
| `start` | — | rozjede hodiny, 50 Hz (snímek PAL) |
| `stop` | — | zastaví hodiny (pauza, ztráta zaměření karty) |
| `play` | `room`, `side`, `global`, `sprites` | **rozehraje místnost**: postaví ji stavitelem originálu, dosadí do paměti tabulky pohybu (`data/global.json`), bloky sprajtů (`data/sprites.json`) a tabulku otočených bitů `$C500`, a postaví agenta. Odpoví `playing` |
| `input` | `joystick` | bajt, který by dal `$DC00` — port 2, **aktivní v nule** (§7). Krok agenta čte jeden bajt na průchod |
| `random` | — | jedna hodnota z generátoru; odpoví `random` |

★ `speech` je rozparsovaný `data/speech.json` (M6): 6 016 B `IM.WORDS`
a tabulky ovladače. Bez něj hra hraje, jen nemluví.

## Worker → hlavní vlákno

| zpráva | pole | co znamená |
|---|---|---|
| `ready` | `seed`, `fortress` | svět stojí, hodiny ještě neběží. `fortress` je to, co se dá o vylosované pevnosti říct bez místností: `password` (jedno z osmi slov originálu), `map` (mřížka 9 × 6, `$FF` = prázdný čtverec), `slots`, `pieces`, `terminals` |
| `room` | `screen`, `color`, `vic`, `spritePointers`, `colors`, `sprites`, `furniture`, `robots`, `controlRoom`, `split` | postavená místnost tak, jak by ji měl stroj: 1 000 znaků obrazovky, 1 000 barev, registry VIC a ukazatele sprajtů. ★ Zapnuté sprajty jsou v `sprites.enabled` z `$8E` (do `$D015` je dá `$A35E`), a **agent mezi nimi ukazatel nemá** — ten plyne z jeho stavu (`$8731`), což je M3 |
| `playing` | `room`, `side`, `agent` | místnost je rozehraná |
| `frame` | `frame`, `cycles`, `agent`, `out`, ★ `picture`, ★ `sprites` | uplynul snímek; **na tuhle zprávu se kreslí** (R-037). `agent` je to, co by měl VIC — tři sprajty agenta i s **bloky čtenými z paměti** (otočkou se zrcadlí, §13), stav, natočení, místo a hodiny; `out` hlásí, co přepis ještě neumí (`searched`, kódová a řídicí místnost) a ★ `computer` (1 kapesní počítač běží, 2 skončil — §34; v těch snímcích krok agenta neběží, protože počítač nahradil smyčku šachty) a ★ `dying` (1 obřad po smrti běží, 2 skončil, §31) — **v těch snímcích svět stojí**, protože na stroji v obřadu drží `SEI`; rozpouštějícího se agenta model kreslí z `agent.blocks`, které míří na `$4D80`, takže se o tom nemusí dozvědět jinak; ★ **`picture` přijde, jen když se obraz změnil** — od M3 se hýbe sám (clony přechodu, jízda šachtou, stavba šachty), takže ho nejde poslat jednou a nechat být, ale ani ho nemá smysl posílat padesátkrát za vteřinu pro nic. Nese celou obrazovku, barvy, kterou sadu VIC čte, kde agent je, **ostatní sprajty** a ★ `irq`, tedy **vektor přerušení** (`$FFFE`): `$82E7` je herní obsluha a dělí obraz rastrovými clonami, `$838C` jen zvedne `$E0` — běží za úvodní řečí (`$391E` ≺ `$BF3A`) a v řídicí místnosti (§35), a v těch chvílích se obraz dělit **nesmí**. ★ **`sprites` je samostatné pole a chodí, jen když se hnul některý registr sprajtu** — od M4 to je nutnost: robot po plošině a koule po místnosti píšou `$D000`–`$D010` a obrazovky se nedotknou (§24), takže s obrazem by zpráva nikdy nepřišla a roboti by stáli. Nese `enabled`, `multicolor`, `expandX`, `expandY`, `msbX` a pole `x`, `y`, `pointer`, `color` po osmi, ★ a k tomu `blocks`: mapu **ukazatel → 64 bajtů** pro ty rozsvícené sprajty, jejichž blok v `data/sprites.json` **není**, protože si ho hra staví za běhu (značka kabiny na mapě pevnosti, `$B6FE` → `$4D80`, tedy blok `$36`). Agentovy sprajty 1–3 v něm jsou taky, ale kreslí se z `agent`, takže na téhle zprávě nezávisí |
| `random` | `value` | odpověď na `random` |

★ Zpráva `frame` nese navíc **`sid`** a **`speech`** (M6, R-044):

- **`sid`** je `[[cyklus, registr, hodnota], …]` — co hra za ten průchod
  napsala do `$D400`–`$D418`, **v pořadí, ve kterém to napsala**
  (`app/sound.js`). Chodí, jen když se něco zapsalo. `cyklus` je jednotka,
  kterou `ChipStream` zápisy rozmisťuje po snímku (19 656 na snímek PAL) —
  ★ a je to **model kadence, ne měření**: co píše obsluha přerušení, jde na
  začátek snímku, co píše hlavní smyčka, doprostřed. Pořadí je originálovo
  a to je to, co se dokládá.
- **`speech`** je `{word, cadence, samples, register}` — ★ **celá věta
  jedním blokem**, protože přehrávač řeči tiká po 101 cyklech, tedy
  195krát za snímek (§18, §32). `samples` jsou čtyřbitové hodnoty pro
  `$D418`, `cadence` je 101. Hra při řeči **stojí**, takže to není nic, co
  by běželo vedle světa.

## Pravidla, která platí od začátku

1. **Worker nikým nehýbe kvůli obrazu.** Obraz se kreslí na zprávu `frame`,
   smyčka modelu je jen záloha, když zpráva nepřijde (pauza, modál) — R-037,
   předloha `manicminer/app/caveModel.js`.
2. **Žádný `Math.random()`.** Náhoda je seedovaný xorshift v `gameWorker.js`
   a dá se dosadit: `trace*` zaznamená, co originál přečetl z hardwaru,
   `match*` to nasype zpátky (`ZADANI.md` §10.4). Semínko jde do losování
   pevnosti na **dvě místa a jen na ně**: stav míchačky originálu
   (`$EB`/`$EC`) a vstup entropie, který na stroji dává rastrový řádek
   (`EOR $D012` na `$82E3`). Sama míchačka je přepsaná doslova.
5. **Worker si bere `fortressGen.js`, `fortressMap.js`, `roomBuild.js`
   a `roomsLoader.js`** přes `importScripts`; pod Node je nástroj nahraje
   ručně a najdou se přes `self` (`tools/runworker.mjs`). Všechny musí být
   dosažitelné URL: v devMode se servírují z `app/`, do bundlu je pustí
   `standalone` v `config/compile.json`. **`?ver=` si worker předá dál** ze
   své vlastní URL, jinak by prohlížeč mohl držet starou kopii sourozence.
6. **Paměť se sype dvakrát a musí si sednout**: nejdřív záznamy místností
   z `data/rooms.json`, pak vstupy losování z `data/fortress.json`. Obojí je
   z jednoho statického obrazu, takže překryv je kontrola (`runworker.mjs`).
3. **Jednotka času je snímek PAL**, 20 ms, 19 656 cyklů 6510 — rozhodnutí
   operátora 2026-09-19 (R-038).
4. Worker je **klasický skript** (`importScripts`), takže v něm nesmí být
   `import` ani `export` (R-001); nástroje si ho berou přes
   `app/svision/tools/classicScript.cjs`.
