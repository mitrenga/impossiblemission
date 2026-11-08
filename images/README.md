# images/ — ikony aplikace a obálka

`poster.png` je plakát hry, `cover.png` je jeho zmenšenina 800 × 600
(paletová PNG8) pro `/about` — stejný tvar jako u sourozenců:

    convert poster.png -resize 800x600 -colors 256 -strip PNG8:cover.png

`app-icon.svg` je **agent ze stroje**, ne kresba: tři sprajty originálu
(stav `$0A`, bloky `$6000+`, hires, barvy `$01` a `$0B`) složené tak, jak je
skládá VIC, jeden obdélník na vodorovný úsek bodů. Pozadí RGB 123,163,176.
Vytažené přes `player.view()` cestou `tools/renderroom.mjs --play`.

PNG sadu a favicon z něj udělají nástroje knihovny (symlinky vedle):

    ./make-app-icons      # app-icon-{192,256,512,1024,1980}x*.png
    ./make-favicon        # favicon.ico (128/64/48/32/16), kopie patří i do kořene

★ **Projekt je do rozhodnutí operátora interní** (`../ZADANI.md` §0): ikony
existují, nasazení ne.
