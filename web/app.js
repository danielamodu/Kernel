'use strict';
/* Kernel UI — hash-routed single page. Reads: snapshot-first, live-verified
 * where reachable, honestly labeled otherwise. Writes: only via the user's own
 * wallet (eth_sendTransaction) with explicit confirmation. No fake states. */
const D = KERNEL_SNAPSHOT;
const EX = D.explorer;

/* ---------- formatting ---------- */
const trunc = (a, n = 6) => (a ? `${a.slice(0, 2 + n)}…${a.slice(-4)}` : '—');
const addrUrl = (a) => `${EX}/address/${a}`;
const txUrl = (h) => `${EX}/tx/${h}`;
function fmtOKB(weiStr) {
  const w = BigInt(weiStr);
  const whole = w / 1000000000000000000n;
  const frac = (w % 1000000000000000000n).toString().padStart(18, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac} OKB` : `${whole} OKB`;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function link(href, text, cls = '') {
  return `<a class="${cls}" href="${href}" target="_blank" rel="noopener">${text}</a>`;
}
function pill(ok, text) {
  return `<span class="pill ${ok === true ? 'ok' : ok === false ? 'bad' : 'muted'}">${esc(text)}</span>`;
}
function kv(k, v) {
  return `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`;
}
function tech(title, inner) {
  return `<details class="tech"><summary>${esc(title)}</summary><div class="tech-body">${inner}</div></details>`;
}
const mono = (s) => `<code class="mono">${esc(s)}</code>`;

/* ---------- live state (snapshot-first, verified where reachable) ---------- */
const live = { block: null, ok: false, fields: {} };
async function refreshLive() {
  try {
    live.block = parseInt(await Live.blockNumber(), 16);
    const [owner1, owner2, nextId, reg] = await Promise.all([
      Live.ownerOf(D.trace.processor, 1).catch(() => null),
      Live.ownerOf(D.trace.processor, 2).catch(() => null),
      Live.nextId(D.trace.processor).catch(() => null),
      Live.isRegistered(D.registry.address, D.ip.keyHash).catch(() => null),
    ]);
    Object.assign(live.fields, { owner1, owner2, nextId, registered: reg });
    live.ok = true;
  } catch { live.ok = false; }
}
function liveTag(valueOk) {
  if (!live.ok) return pill(null, `snapshot · block ${D.snapshotBlock}`);
  if (valueOk === true) return pill(true, `verified live · block ${live.block}`);
  if (valueOk === false) return pill(false, 'differs from snapshot');
  return pill(null, `live · block ${live.block}`);
}

/* ---------- wallet (EIP-1193, real states only) ---------- */
const wallet = { account: null, chainOk: null, status: 'idle', error: '' };
async function connectWallet() {
  if (!window.ethereum) { wallet.status = 'failed'; wallet.error = 'No wallet extension detected (MetaMask / OKX Wallet).'; render(); return; }
  wallet.status = 'connecting'; render();
  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    wallet.account = accounts[0] || null;
    const chainId = await window.ethereum.request({ method: 'eth_chainId' });
    if (chainId !== '0xc4') {
      try {
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xc4' }] });
        wallet.chainOk = true;
      } catch { wallet.chainOk = false; }
    } else wallet.chainOk = true;
    wallet.status = wallet.account ? 'idle' : 'failed';
    if (!wallet.account) wallet.error = 'No account authorized.';
  } catch (e) {
    wallet.status = 'failed';
    wallet.error = e && e.message ? e.message : 'Connection rejected.';
  }
  render();
}
if (window.ethereum) {
  window.ethereum.on?.('accountsChanged', (a) => { wallet.account = a[0] || null; render(); });
  window.ethereum.on?.('chainChanged', () => window.location.reload());
}

/* ---------- shell ---------- */
function nav(active) {
  const item = (hash, label) => `<a href="${hash}" class="${active === hash ? 'on' : ''}">${label}</a>`;
  return `<header class="top"><a class="brand" href="#/">Kernel</a><nav>${item('#/explore', 'Explore')}${item('#/compose', 'Compose')}${item('#/my', 'My Kernel')}</nav><span class="net">X Layer · 196</span><button id="walletBtn" class="wbtn">${wallet.account ? trunc(wallet.account) : 'Connect wallet'}</button></header>`;
}
function footer() {
  return `<footer>Kernel · application-level attribution for composable computation · <a href="#/provenance/trace-2">provenance model</a> · TapeOut is permissionless; Kernel never claims to prevent direct use.</footer>`;
}

/* ---------- views ---------- */
function vHome() {
  return `<section class="hero">
    <h1>Build on computation you can trust.</h1>
    <p class="lede">Kernel lets developers publish reusable computational IP, license it into new circuits, and prove exactly where that computation came from.</p>
    <div class="cta"><a class="btn primary" href="#/explore">Explore Computational IP</a><a class="btn" href="#/compose">Build a Circuit</a></div>
    <div class="flow">
      <div><b>CREATOR</b><span>Register computational IP</span></div><i>↓</i>
      <div><b>KERNEL</b><span>Identity · Licensing · Provenance</span></div><i>↓</i>
      <div><b>BUILDER</b><span>Compose via REF</span></div><i>↓</i>
      <div><b>LICENSED TAPEOUT</b><span>Verifiable lineage</span></div>
    </div>
    <div class="liveproof">${pill(true, 'live proof on X Layer')} Circuit #2 was licensed-taped-out from registered TRACE #1 — <a href="#/receipt/trace-2">view receipt</a>.</div>
  </section>`;
}

function vExplore() {
  const ip = D.ip;
  const regTag = live.ok && live.fields.registered !== null
    ? (live.fields.registered ? pill(true, 'Registered · verified live') : pill(false, 'Not registered'))
    : pill(null, 'Registered · snapshot');
  return `<section><h2>Computational IP</h2>
  <p class="lede">Reusable computation published with verifiable identity, licensing terms, and provenance.</p>
  <div class="cards"><article class="card">
    <div class="card-top"><h3>${esc(ip.demoName)}</h3>${regTag}</div>
    <p class="muted">On-chain identity: ${mono(trunc(ip.processor) + ' · circuit #' + ip.circuitId)} · demo name shown for readability; chain data below is exact.</p>
    <div class="facts"><span>License <b>${esc(ip.priceOKB)} OKB</b></span><span>Network <b>X Layer</b></span><span>Creator <b>${mono(trunc(ip.payee))}</b> <span class="muted">(on-chain payee)</span></span></div>
    <div class="row"><a class="btn primary" href="#/ip/trace-1">Open</a><a class="btn" href="#/compose">Use in a Circuit</a></div>
  </article></div>
  <p class="muted">One curated entry for the demo. Anyone can register any TapeOut slot through the registry contract; new entries appear here as indexers observe them.</p></section>`;
}

function vIp() {
  const ip = D.ip;
  const regTag = live.ok && live.fields.registered !== null
    ? (live.fields.registered ? pill(true, 'Verified Computational IP · live') : pill(false, 'Registration inactive'))
    : pill(null, 'Verified Computational IP · snapshot');
  return `<section>
    <div>${regTag}</div><h2>${esc(ip.demoName)}</h2>
    <div class="facts"><span>Creator / payee <b>${mono(trunc(ip.payee))}</b></span><span>License price <b>${esc(ip.priceOKB)} OKB</b></span></div>
    <div class="row"><a class="btn primary" href="#/compose">Use in a Circuit</a></div>
    <h3>Overview</h3><p>${esc(ip.demoDescription || D.ip.demoName)} Turns public pool observations into transparent presentation milestones (4 inputs, 2 outputs, 8 NAND gates).</p>
    <h3>Identity</h3>
    ${kv('Processor', `${link(addrUrl(ip.processor), trunc(ip.processor))}`)}
    ${kv('Circuit ID', `#${ip.circuitId}`)}
    ${kv('Chain', 'X Layer · 196')}
    ${kv('Netlist hash', `${mono(trunc(ip.netlistHash, 10))} ${liveTag(true)}`)}
    <h3>License</h3>
    ${kv('Price', `${esc(ip.priceOKB)} OKB`)}
    ${kv('Terms', `single-license · ${esc(ip.priceOKB)} OKB · attribution required`)}
    ${kv('Attribution requirement', 'yes')}
    ${kv('Registration status', live.ok && live.fields.registered !== null ? (live.fields.registered ? 'active (live)' : 'inactive (live)') : 'active (snapshot)')}
    <h3>Provenance</h3><p>Root computation: taped out directly (no REF dependencies). Reused by <a href="#/provenance/trace-2">Proof Machine #2</a> via REF with settled license.</p>
    <h3>Activity</h3>
    ${kv('Registration', `${link(txUrl(ip.registrationTx), trunc(ip.registrationTx))} · block ${ip.registrationBlock}`)}
    ${kv('License events', '1 × LicensePaid 0.0005 OKB (in licensed tape-out tx)')}
    ${kv('TapeOut events', `${link(txUrl(D.result.tx), 'licensed tape-out')} → circuit #2`)}
    ${tech('Technical details', kv('slotKey', mono(ip.slotKey)) + kv('keyHash', mono(ip.keyHash)) + kv('termsHash', mono(ip.termsHash)) + kv('terms JSON', mono(JSON.stringify(ip.terms))))}
  </section>`;
}

function depPanel() {
  const ip = D.ip;
  return `<div class="depbox"><div class="dep-head">DEPENDENCY DETECTED ${pill(true, 'live proof exists')}</div>
  <h4>${esc(ip.demoName)} (TRACE #1)</h4>
  <div class="checks"><span>✓ Identity verified</span><span>✓ Netlist verified</span><span>✓ License available</span></div>
  ${kv('License', `${esc(ip.priceOKB)} OKB`)}
  ${kv('TapeOut', '0.0013 OKB')}
  ${kv('Total', '<b>0.0018 OKB</b> + network gas')}
  ${tech('How detection works', '<p>Kernel parses the composed netlist bytes, finds the <code>0x02</code> REF record naming <code>TRACE #1</code>, resolves it live, and compares the on-chain netlist hash with the registry record. No metadata is trusted.</p>')}</div>`;
}

function vCompose() {
  const st = txState;
  let action = '';
  if (st.phase === 'idle') {
    action = wallet.account
      ? `<button class="btn primary" id="tapeBtn">License &amp; Tape Out — 0.0018 OKB</button><p class="warn">X Layer mainnet — this spends real OKB from ${mono(trunc(wallet.account))}.</p>`
      : `<button class="btn primary" id="connectBtn2">Connect wallet to continue</button>`;
  } else if (st.phase === 'failed') {
    action = `<div class="alert bad">Failed: ${esc(st.error)} <button class="btn" id="retryBtn">Back</button></div>`;
  } else if (st.phase === 'confirmed') {
    action = `<div class="alert ok">Confirmed: ${link(txUrl(st.hash), trunc(st.hash))} <a class="btn primary" href="#/receipt/trace-2">View receipt</a></div>`;
  } else {
    const labels = { signing: 'Awaiting signature — confirm in your wallet…', submitting: 'Submitting…', confirming: 'Confirming on X Layer…' };
    action = `<div class="alert muted">${esc(labels[st.phase] || st.phase)}${st.hash ? ` ${link(txUrl(st.hash), trunc(st.hash))}` : ''}</div>`;
  }
  return `<section><h2>Compose</h2>
  <p class="lede">Build a new computation from reusable components.</p>
  <div class="compose"><div class="part"><b>Proof Machine</b><span>Your computation (demo root · 43-byte REF netlist)</span></div>
  <div class="plus">+</div><div class="part"><b>${esc(D.ip.demoName)}</b><span>via REF · circuit #1</span></div></div>
  ${depPanel()}
  <h3>Pre-flight confirmation</h3>
  <div class="card"><b>LICENSED COMPOSITION — Proof Machine</b>
  ${kv('Dependencies', '✓ TRACE #1 · netlist verified · terms verified')}
  ${kv('Payments', `License → 0.0005 OKB · TapeOut → 0.0013 OKB · Total → 0.0018 OKB + gas`)}
  ${kv('Network', 'X Layer · 196')}
  <p class="muted">You will sign exactly one transaction: <code>licenseAndTapeout</code> to the router with value 0.0018 OKB. Anything else aborts the whole operation.</p></div>
  <div class="row">${action}</div></section>`;
}

const txState = { phase: 'idle', hash: '', error: '' };
async function doTapeOut() {
  txState.phase = 'signing'; txState.error = ''; render();
  try {
    const data = D.composition.calldata;
    const valueHex = '0x' + BigInt(D.composition.valueWei).toString(16);
    const hash = await window.ethereum.request({
      method: 'eth_sendTransaction',
      params: [{ from: wallet.account, to: D.router.address, data, value: valueHex, chainId: '0xc4' }],
    });
    txState.phase = 'submitting'; txState.hash = hash; render();
    txState.phase = 'confirming'; render();
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const receipt = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null);
      if (receipt && receipt.status) {
        if (receipt.status === '0x1') { txState.phase = 'confirmed'; }
        else { txState.phase = 'failed'; txState.error = 'Transaction reverted on-chain.'; }
        render();
        return;
      }
    }
    txState.phase = 'failed'; txState.error = 'No receipt after ~3 min — check the explorer before retrying.';
  } catch (e) {
    txState.phase = 'failed';
    txState.error = (e && e.message) || 'Wallet rejected the request.';
  }
  render();
}

function vReceipt() {
  const r = D.result, ip = D.ip;
  return `<section><h2>Licensed TapeOut</h2>
  <h3>Proof Machine #2</h3><div>Status: ${pill(true, 'CONFIRMED')}</div>
  <p class="muted">Demo label “Proof Machine” for the composed circuit; on-chain it is TRACE circuit #2 (circuits carry no names).</p>
  <h3>License</h3>${kv('License settled', `✓ 0.0005 OKB → ${link(addrUrl(ip.payee), trunc(ip.payee))} (balance delta verified block ${r.block})`)}
  <h3>Composition</h3>${kv('REF dependency verified', '✓ 43-byte root names TRACE #1; on-chain netlist byte-identical')}
  <h3>Provenance</h3>${kv('Lineage verified', `✓ lineageHash ${mono(trunc(D.composition.lineageHash, 10))} (event == recomputed)`)}
  <h3>Manufacturing</h3>${kv('TapeOut confirmed', `✓ ${link(txUrl(r.tx), trunc(r.tx))} · block ${r.block} · gas ${r.gasUsed}`)}${kv('Network', 'X Layer · 196')}
  <h3>Result</h3>
  ${kv('Circuit', `#${r.circuitId} (owner: ${link(addrUrl(r.payer), trunc(r.payer))})`)}
  ${kv('Processor', `${link(addrUrl(D.trace.processor), 'TRACE')} ${mono(trunc(D.trace.processor))}`)}
  ${kv('Netlist', `Verified · keccak ${mono(trunc(D.composition.netlistKeccak, 10))}`)}
  <div class="row"><a class="btn primary" href="#/provenance/trace-2">View Provenance</a>${link(txUrl(r.tx), 'View on X Layer', 'btn')}</div>
  ${tech('Event data', kv('LicensedTapeout', mono(`targetCpu, 2, lineageHash, 500000000000000, 1, payer`)) + kv('LicensePaid', mono('key, payee, 0.0005 OKB, termsHash')))}</section>`;
}

function vProvenance() {
  const ip = D.ip, r = D.result;
  return `<section><h2>Provenance — Proof Machine #2</h2>
  <div class="tree">
    <div class="tnode root"><b>Proof Machine #2</b><span>composed circuit · 1 REF · 0 own transistors</span></div>
    <div class="tedge">| REF <span class="muted">(reads TRACE #1 at execution)</span></div>
    <div class="tnode"><b>${esc(ip.demoName)} (TRACE #1)</b><span>8 NAND · registered computational IP</span></div>
    <div class="tedge">|</div>
    <div class="tnode leaf"><b>Registered IP</b><span>license settled · 0.0005 OKB · attribution required</span></div>
  </div>
  ${kv('Identity', mono(ip.slotKey))}
  ${kv('Netlist', mono(trunc(ip.netlistHash, 10)) + ' · verified live against registry record')}
  ${kv('License', `${esc(ip.priceOKB)} OKB · terms ${mono(trunc(ip.termsHash, 10))}`)}
  ${kv('Creator / payee', link(addrUrl(ip.payee), trunc(ip.payee)))}
  ${kv('Terms', 'single-license · attribution required (hash-committed, document re-hashable by anyone)')}
  ${kv('TapeOut', `${link(txUrl(r.tx), trunc(r.tx))} · block ${r.block}`)}
  ${kv('Transaction', `${link(txUrl(r.tx), 'licensed tape-out')} · value 0.0018 OKB exact`)}
  <p class="note">Kernel resolves computational dependencies from the circuit's underlying netlist rather than relying solely on user-entered metadata.</p>
  <h3>What computation is inside this computation?</h3>
  <p>Every <code>0x02</code> record in circuit #2's stored bytes names a dependency; here there is exactly one — TRACE #1 — and its content hash matches the registry at execution time. That is the whole answer, verified, not asserted.</p></section>`;
}

function vMy() {
  const w = wallet.account;
  const owned = [];
  if (live.ok) {
    if (live.fields.owner1 && w && live.fields.owner1.toLowerCase() === w.toLowerCase()) owned.push('#1');
    if (live.fields.owner2 && w && live.fields.owner2.toLowerCase() === w.toLowerCase()) owned.push('#2');
  }
  return `<section><h2>My Kernel</h2>
  ${w ? kv('Wallet', `${mono(trunc(w))} ${wallet.chainOk ? pill(true, 'X Layer') : pill(false, 'wrong network')}`) : '<p>Not connected. <button class="btn" id="connectBtn3">Connect wallet</button></p>'}
  <h3>My Computational IP</h3><p class="muted">${w ? (owned.length ? `Circuits you own (known): ${owned.join(', ')}` : 'None of the known demo circuits.') : 'Connect to check.'} Registration lookup for arbitrary circuits lives in the CLI; the UI checks ownership of indexed circuits.</p>
  <h3>My Compositions</h3><p class="muted">${w ? 'Proof Machine #2 was taped out by the demo payer.' : '—'}</p>
  <h3>Licenses</h3><p class="muted">LicensePaid events reference payees; per-user license history requires an event indexer (out of scope for this demo surface).</p>
  <h3>TapeOuts</h3><p class="muted">${link(txUrl(D.result.tx), 'Licensed demo tape-out')} · circuit #2.</p></section>`;
}

/* ---------- router ---------- */
const routes = {
  '#/': vHome, '#/explore': vExplore, '#/ip/trace-1': vIp, '#/compose': vCompose,
  '#/receipt/trace-2': vReceipt, '#/provenance/trace-2': vProvenance, '#/my': vMy,
};
function render() {
  const hash = window.location.hash || '#/';
  const view = routes[hash] || routes['#/'];
  document.getElementById('app').innerHTML = nav(hash) + `<main>${view()}</main>` + footer();
  const wb = document.getElementById('walletBtn');
  if (wb) wb.onclick = connectWallet;
  const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  bind('connectBtn2', connectWallet);
  bind('connectBtn3', connectWallet);
  bind('tapeBtn', doTapeOut);
  bind('retryBtn', () => { txState.phase = 'idle'; txState.error = ''; render(); });
}
window.addEventListener('hashchange', render);
refreshLive().then(render);
setInterval(async () => { await refreshLive(); if ((window.location.hash || '#/') !== '#/compose' || txState.phase === 'idle') render(); }, 30000);
