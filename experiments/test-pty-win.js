// 在 Electron 主进程运行时里实测 node-pty 能否在 Windows spawn + 出数据。
// 用法：npx electron experiments/test-pty-win.js
// 这证明「终端能力」在 Electron（不是裸 Node）里真的可用。
const { app } = require('electron');
app.whenReady().then(() => {
  let pty = null;
  try { pty = require('node-pty'); }
  catch (e) { console.log('FAIL require node-pty:', e.message); app.exit(1); return; }
  const shell = process.env.COMSPEC || 'powershell.exe';
  let got = '';
  let done = false;
  const finish = (ok, msg) => { if (done) return; done = true; console.log((ok ? 'PASS' : 'FAIL') + ': ' + msg); app.exit(ok ? 0 : 1); };
  try {
    const p = pty.spawn(shell, [], { cols: 80, rows: 24, cwd: require('os').homedir() });
    p.onData((d) => {
      got += d;
      // 等到看到回显的标记 = PTY 双向数据通路通了
      if (got.includes('PTY_OK_MARKER') || got.length > 30) { /* 等回显 */ }
    });
    setTimeout(() => p.write("echo PTY_OK_MARKER\r"), 400);
    setTimeout(() => {
      const ok = got.includes('PTY_OK_MARKER') || got.includes('PTY_OK');
      console.log('--- 终端前 200 字节输出 ---');
      console.log(JSON.stringify(got.slice(0, 200)));
      finish(ok, ok ? 'node-pty 在 Electron spawn 成功，命令回显正常（终端可用）'
        : 'spawn 了但没收到回显（PTY 输出通路异常），前200字节见上');
    }, 1800);
    setTimeout(() => finish(false, '超时'), 4000);
  } catch (e) { finish(false, 'spawn 抛错: ' + e.message); }
});
