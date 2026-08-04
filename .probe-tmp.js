const { app, BrowserWindow } = require('electron');

const WIDTHS = [1512, 1440, 1280, 1152, 1024];

const MEASURE = `(() => {
  const r = el => { const b = el ? el.getBoundingClientRect() : null; return b ? {x: Math.round(b.x), w: Math.round(b.width), right: Math.round(b.right)} : null; };
  const q = s => document.querySelector(s);
  const ha = q('.header-actions');
  return {
    vw: window.innerWidth,
    docScrollW: document.documentElement.scrollWidth,
    docClientW: document.documentElement.clientWidth,
    bodyScrollW: document.body.scrollWidth,
    headerScrollW: q('.header') ? q('.header').scrollWidth : null,
    headerClientW: q('.header') ? q('.header').clientWidth : null,
    headerActionsMinContent: ha ? Math.round([...ha.children].reduce((s,c)=>s+c.getBoundingClientRect().width,0) + (ha.children.length-1)*8) : null,
    headerActions: r(ha),
    headerLeft: r(q('.header-left')),
    sidebar: r(q('.manuscript-list')),
    workArea: r(q('.work-area')),
    editorPane: r(q('.editor-pane')),
    resizer: r(q('#pane-resizer')),
    scorePane: r(q('.score-pane')),
    scorePaneVisible: (() => { const b = q('.score-pane'); if (!b) return null; const bb = b.getBoundingClientRect(); return bb.width > 0 && bb.right <= window.innerWidth + 1; })(),
  };
})()`;

app.commandLine.appendSwitch('force-device-scale-factor', '1');

app.whenReady().then(async () => {
  const out = [];
  for (const w of WIDTHS) {
    const win = new BrowserWindow({ width: w, height: 900, show: false, useContentSize: true });
    await win.loadFile('scorer.html');
    await new Promise(r => setTimeout(r, 1200));
    const res = await win.webContents.executeJavaScript(MEASURE);
    out.push(res);
    win.destroy();
  }
  console.log(JSON.stringify(out, null, 1));
  app.quit();
});
