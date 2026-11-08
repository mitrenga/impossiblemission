<?php
  $appName = 'Impossible Mission';
  $appDescription = 'Remake of Impossible Mission (Epyx, 1984, Commodore 64) on the svision library. Internal project: nothing here is published.';
  $appPrefix = 'im';
  $devMode = true;                       // the project runs locally only (ZADANI.md §0)
  if (file_exists(__DIR__.'/config/config.php')) {
    require_once __DIR__.'/config/config.php';
  }
  require_once 'app/svision/php/main.php';
