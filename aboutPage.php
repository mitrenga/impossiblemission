<?php

require_once 'app/svision/php/abstractAboutPage.php';

/**
 * The /about page: the story of the original Impossible Mission and of this
 * remake, with links to Wikipedia, C64-Wiki and Lemon64.
 *
 * ★ **The project is internal** (`ZADANI.md` §0): the rights to the game are
 * alive (? System 3) and the operator decides about any use only after the
 * letter to the rights holder. The page therefore describes the work and
 * says who owns the original — it does not advertise the game, does not link
 * to `gallery` and does not cross-promote the published remakes.
 */
class AboutPage extends AbstractAboutPage {

  protected function aboutData() {
    return [
      'description' =>
        'Impossible Mission (Epyx, 1984, Commodore 64) rebuilt for the browser on the svision '.
        'library — the fortress is shuffled, the rooms are built and the speech is played by the '.
        'routines of the original. An internal study project, not published.',
      'image' => 'images/cover.png',
      'sections' => [
        [
          'heading' => 'The original game (1984)',
          'html' =>
            '<p>Impossible Mission was written by Dennis Caswell and published by Epyx in 1984 for the '.
            'Commodore 64; in Europe it came out under U.S. Gold. Agent 4125 has six hours to break into '.
            'the underground stronghold of Professor Elvin Atombender, who is working his way into '.
            'military computers and towards a missile launch. The stronghold has thirty-two rooms of '.
            'catwalks and lifts, patrolled by robots that kill on touch, and the only weapons the agent '.
            'gets are a pocket computer and his own head.</p>'.
            '<p>The password to the control room is hidden in the furniture, torn into pieces: every piece '.
            'of furniture has to be searched, and the fragments found there are put together in the pocket '.
            'computer as jigsaw puzzles. The game is remembered for two things — the somersaulting, '.
            'rotoscoped-looking agent, and the speech. Digitised sentences were rare on the Commodore 64 '.
            'in 1984, and Elvin greeting the player has outlived the game itself.</p>',
        ],
        [
          'heading' => 'How the machine makes it',
          'html' =>
            '<p>Nothing in the fortress is a picture. A room is <em>built</em> from a record — floors, '.
            'pillars, furniture, lifts, robots — and both the layout of the fortress and the contents of '.
            'the furniture are shuffled at the start of every game, so no two missions are the same. The '.
            'lift shaft between the rooms is not scrolled either: it is assembled one character row at a '.
            'time as the cabin moves.</p>'.
            '<p>The speech is not a recording. It is 6 016 bytes of four-bit samples written to the volume '.
            'register of the SID sound chip, one sample every 101 processor cycles, driven by a timer '.
            'interrupt — which is why the rest of the game stands still while Elvin talks.</p>',
        ],
        [
          'heading' => 'This remake',
          'html' =>
            '<p>This is not a game that looks like Impossible Mission. It is the program of the original, '.
            'read out of the machine and rewritten routine by routine in JavaScript on the svision '.
            'library, which models the Commodore 64 itself: the VIC-II video chip with its sprites, '.
            'hardware collisions and raster splits, and a model of the SID 6581 that reproduces the '.
            'speech from the original samples. Nothing is redrawn and nothing is approximated.</p>'.$this->installNote(),
        ],
        [
          'heading' => 'Other games',
          'html' =>
            '<p>This remake is one of a growing collection of classic games from the 8-bit and 16-bit era '.
            '— ZX Spectrum, Commodore 64, arcade and more — rebuilt faithfully on the same library and '.
            'playable in your browser, free of charge. Browse the whole collection at '.
            '<a href="https://retrogames.free/" target="_blank" rel="noopener">retrogames.free</a>.</p>',
        ],
      ],
      'links' => [
        ['label' => 'Impossible Mission on Wikipedia', 'url' => 'https://en.wikipedia.org/wiki/Impossible_Mission'],
        ['label' => 'Dennis Caswell on Wikipedia', 'url' => 'https://en.wikipedia.org/wiki/Dennis_Caswell'],
        ['label' => 'Impossible Mission on C64-Wiki', 'url' => 'https://www.c64-wiki.com/wiki/Impossible_Mission'],
        ['label' => 'Game entry on Lemon64', 'url' => 'https://www.lemon64.com/game/impossible-mission'],
        ['label' => 'System 3 — the publisher of the later Impossible Mission releases', 'url' => 'https://www.system3.com/'],
      ],
      'footer' =>
        '<p>An unofficial fan remake, made as a study of the Commodore 64. The original game, its '.
        'artwork and its speech belong to their authors and rights holders — &copy; Epyx, Inc. 1984, '.
        'later releases by System 3. This remake is not distributed and is not for sale.</p>',
    ];
  } // aboutData

} // AboutPage
