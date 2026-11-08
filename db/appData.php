<?php
/**
 * The server side, in the smallest shape the application needs to run
 * locally. The project is internal (`ZADANI.md` §0): there is no public hall
 * of fame and no database behind this — the file answers so that the
 * application has something to talk to.
 */
function appData() {
  return [
    'hiScore' => 0,
    'hallOfFame' => [],
  ];
}
