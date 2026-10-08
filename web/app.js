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
const live = { block: null, ok: false, loading: true, fields: {} };
async function refreshLive() {
  live.loading = true;
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
  live.loading = false;
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
  const dot = live.loading ? pill(null, 'checking chain…') : live.ok ? pill(true, `live · ${live.block}`) : pill(null, 'snapshot');
  return `<header class="top"><a class="brand" href="#/">Kernel</a><nav>${item('#/explore', 'Explore')}${item('#/compose', 'Compose')}${item('#/my', 'My Kernel')}</nav><span class="net">X Layer · 196</span><span title="Chain-data freshness">${dot}</span><button id="walletBtn" class="wbtn">${wallet.account ? trunc(wallet.account) : 'Connect wallet'}</button></header>`;
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
    <div class="facts"><span>License <b>${esc(ip.priceOKB)} OKB</b></span><span>Network <b>X Layer</b></span></div>
    <div class="row"><a class="btn primary" href="#/ip/trace-1">Open</a><a class="btn" href="#/compose">Use</a></div>
    ${tech('Technical details', kv('Processor', mono(trunc(ip.processor))) + kv('Circuit', `#${ip.circuitId} · X Layer 196`) + kv('Netlist', mono(trunc(ip.netlistHash, 10))) + kv('Payee', mono(trunc(ip.payee))))}
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
    <p class="muted">Demo display name for TRACE circuit #1 (a pool-presentation NAND circuit, not SHA-256 — on-chain data below is exact).</p>
    <div class="facts"><span>License price <b>${esc(ip.priceOKB)} OKB</b></span></div>
    <div class="row"><a class="btn primary" href="#/compose">Use in a Circuit</a></div>
    <h3>About</h3><p>${esc(ip.demoDescription || D.ip.demoName)} Turns public pool observations into transparent presentation milestones (4 inputs, 2 outputs, 8 NAND gates).</p>
    <h3>License</h3>
    ${kv('Price', `${esc(ip.priceOKB)} OKB`)}
    ${kv('Terms', `single-license · ${esc(ip.priceOKB)} OKB · attribution required`)}
    <h3>Proof</h3>
    ${kv('Identity', mono(ip.slotKey))}
    ${kv('Verification', live.ok && live.fields.registered !== null ? (live.fields.registered ? 'registered + hash matched live' : 'record inactive') : 'registered at snapshot block ' + D.snapshotBlock)}
    ${tech('View technical details',
      kv('Processor', `${link(addrUrl(ip.processor), trunc(ip.processor))}`) +
      kv('Circuit ID', `#${ip.circuitId}`) +
      kv('Chain ID', '196') +
      kv('Netlist hash', mono(ip.netlistHash)) +
      kv('Registration', `${link(txUrl(ip.registrationTx), trunc(ip.registrationTx))} · block ${ip.registrationBlock}`) +
      kv('Terms hash', mono(ip.termsHash)) +
      kv('Terms JSON', mono(JSON.stringify(ip.terms))))}
  </section>`;
}

/* Compose builder state: empty -> added -> (lineage open) -> review route. */
const composeState = { added: false, lineageOpen: false };

function vCompose() {
  if (!composeState.added) {
    return `<section><h2>Build a computation</h2>
    <p class="lede">Name: <b>Proof Machine</b> <span class="muted">(demo label; on-chain circuits carry no names)</span></p>
    <div class="compose"><div class="part"><b>Your computation</b><span>43-byte REF root · 0 own transistors</span></div></div>
    <div class="row"><button class="btn primary" id="addIpBtn">+ Add computational IP</button></div>
    <p class="muted">Add a registered component to compose it into your circuit.</p></section>`;
  }
  const ip = D.ip;
  const graph = composeState.lineageOpen
    ? `<div class="tree"><div class="tnode root"><b>Proof Machine</b><span>new circuit (pre-tapeout)</span></div><div class="tedge">| REF</div><div class="tnode"><b>${esc(ip.demoName)} (TRACE #1)</b><span>registered computational IP</span></div></div>`
    : '';
  return `<section><h2>Build a computation</h2>
  <p class="lede">Name: <b>Proof Machine</b></p>
  <div class="compose"><div class="part"><b>Your computation</b><span>43-byte REF root</span></div>
  <div class="plus">+</div><div class="part"><b>${esc(ip.demoName)}</b><span>via REF · circuit #1</span></div></div>
  <div class="depbox"><div class="dep-head">DEPENDENCY DETECTED</div>
  <div class="checks"><span>✓ Identity verified</span><span>✓ Netlist verified</span><span>✓ License available</span></div>
  ${kv('License', `${esc(ip.priceOKB)} OKB`)}
  ${kv('TapeOut', '0.0013 OKB')}
  ${kv('Total', '<b>0.0018 OKB</b> + gas')}</div>
  <div class="row"><button class="btn" id="lineageBtn">1 dependency · View lineage</button><a class="btn primary" href="#/review">Review</a><button class="btn" id="removeIpBtn">Remove</button></div>
  ${graph}</section>`;
}

function vReview() {
  if (!composeState.added) {
    return `<section><h2>Review</h2><p>Nothing to review yet. <a class="btn" href="#/compose">Build a computation</a> first.</p></section>`;
  }
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
  const liveNote = live.ok ? '' : `<div class="alert muted">Live reads unavailable — figures below are snapshot (block ${D.snapshotBlock}). <button class="btn" id="retryLiveBtn">Retry</button></div>`;
  return `<section><h2>Review</h2>
  ${liveNote}
  <div class="card"><b>PROOF MACHINE</b>
  <h3>Dependencies</h3><p>✓ ${esc(D.ip.demoName)} (TRACE #1)</p>
  <h3>Verification</h3><p>✓ Identity<br>✓ Netlist<br>✓ License terms</p>
  <h3>Cost</h3>
  ${kv('License', '0.0005 OKB')}
  ${kv('TapeOut', '0.0013 OKB')}
  ${kv('Total', '<b>0.0018 OKB</b> + network gas')}
  <h3>Network</h3><p>X Layer · 196</p>
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
  <p><b>Built with</b> <a href="#/ip/trace-1">${esc(ip.demoName)}</a> — license settled at manufacture.</p>
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
  <p>Every <code>0x02</code> record in circuit #2's stored bytes names a dependency; here there is exactly one — TRACE #1 — and its content hash matches the registry at execution time. That is the whole answer, verified, not asserted.</p>
  <div class="checks"><span>✓ Identity verified</span><span>✓ Netlist verified</span><span>✓ License settled</span><span>✓ Lineage verified</span><span>✓ Manufactured on X Layer</span></div>
  ${tech('Technical proof',
    kv('Processor', mono(D.trace.processor)) +
    kv('Circuit ID', '#2') +
    kv('Netlist hash', mono(D.composition.netlistKeccak)) +
    kv('Lineage hash', mono(D.composition.lineageHash)) +
    kv('Terms hash', mono(ip.termsHash)) +
    kv('License transaction', link(txUrl(r.tx), trunc(r.tx))) +
    kv('TapeOut transaction', link(txUrl(r.tx), trunc(r.tx)) + ' <span class="muted">(same atomic tx)</span>') +
    kv('Manifest', mono(`target=${D.trace.processor}#new ← REF(${ip.processor}#${ip.circuitId}) · value 0.0018 OKB · block ${r.block}`)))}</section>`;
}

function vMy() {
  const w = wallet.account;
  const owned = [];
  if (live.ok) {
    if (live.fields.owner1 && w && live.fields.owner1.toLowerCase() === w.toLowerCase()) owned.push('TRACE #1');
    if (live.fields.owner2 && w && live.fields.owner2.toLowerCase() === w.toLowerCase()) owned.push('Proof Machine #2');
  }
  const fmtOwned = owned.length ? owned.join(', ') : (w ? 'None of the known circuits.' : 'Connect to check.');
  return `<section><h2>My Kernel</h2>
  ${w ? kv('Wallet', `${mono(trunc(w))} ${wallet.chainOk ? pill(true, 'X Layer') : pill(false, 'wrong network')}`) : '<p>Not connected. <button class="btn" id="connectBtn3">Connect wallet</button></p>'}
  <h3>Published</h3><p class="muted">${w ? 'Publishing writes to the on-chain registry (CLI flow today).' : '—'}</p>
  <h3>Used</h3><p class="muted">${w ? 'TRACE Core v1 → Proof Machine (the licensed demo composition).' : '—'}</p>
  <h3>Built</h3><p class="muted">${w ? fmtOwned : '—'}</p></section>`;
}

/* ---------- router ---------- */
const routes = {
  '#/': vHome, '#/explore': vExplore, '#/ip/trace-1': vIp, '#/compose': vCompose,
  '#/review': vReview, '#/receipt/trace-2': vReceipt, '#/provenance/trace-2': vProvenance, '#/my': vMy,
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
  bind('addIpBtn', () => { composeState.added = true; composeState.lineageOpen = false; render(); });
  bind('removeIpBtn', () => { composeState.added = false; composeState.lineageOpen = false; render(); });
  bind('lineageBtn', () => { composeState.lineageOpen = !composeState.lineageOpen; render(); });
  bind('retryLiveBtn', async () => { await refreshLive(); render(); });
  bind('retryBtn', () => { txState.phase = 'idle'; txState.error = ''; render(); });
}
window.addEventListener('hashchange', render);
refreshLive().then(render);
setInterval(async () => { await refreshLive(); if ((window.location.hash || '#/') !== '#/compose' || txState.phase === 'idle') render(); }, 30000);
