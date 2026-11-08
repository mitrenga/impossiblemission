const { MainApp } = await import('./mainApp.js?ver='+window.srcVersion);
const { appPlatform } = await import('./appPlatform.js?ver='+window.srcVersion);
const { bootstrapApp } = await import('./svision/js/appBootstrap.js?ver='+window.srcVersion);
// begin code

const mainApp = new MainApp(appPlatform(), window.importPath, window.wsURL, window.devModeName);

bootstrapApp(mainApp);
