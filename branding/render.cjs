// Рисует SVG в PNG через Electron: electron render.cjs <svg> <png> <w> <h> [transparent|dark]
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const [svg, out, w, h] = process.argv.slice(process.argv.indexOf('--') + 1);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const W = +w, H = +h;
  const win = new BrowserWindow({ width: W + 16, height: H + 16, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: false } });
  const data = fs.readFileSync(svg).toString('base64');
  await win.loadURL('data:text/html,' + encodeURIComponent(`<body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${data}" style="display:block;width:${W}px;height:${H}px">`));
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: W, height: H });
  fs.writeFileSync(out, img.toPNG());
  app.quit();
});
