// Tiny demo app: a menu page with a cart + a JSON API. Used to try regtest locally.
const http = require('http');
const orders = [];
const page = `<!doctype html><title>Demo Menu</title><h1 id=title>Demo Menu</h1>
<ul><li>Pho <button class=add data-n=Pho>Add</button></li><li>Banh mi <button class=add data-n="Banh mi">Add</button></li></ul>
<div>Cart: <span id=count>0</span></div><ul id=cart></ul><button id=checkout>Checkout</button><div id=msg hidden></div>
<script>let c=[];document.querySelectorAll('.add').forEach(b=>b.onclick=()=>{c.push(b.dataset.n);
count.textContent=c.length;cart.innerHTML=c.map(x=>'<li>'+x+'</li>').join('')});
checkout.onclick=async()=>{const r=await fetch('/api/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({items:c})});
const j=await r.json();msg.hidden=false;msg.textContent=r.ok?'Order '+j.id+' placed':'Error: '+j.error}</script>`;
http.createServer((req, res) => {
  const json = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.url === '/' ) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page); }
  if (req.url === '/api/health') return json(200, { ok: true });
  if (req.url === '/api/orders' && req.method === 'POST') { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
    const { items } = JSON.parse(b || '{}'); if (!items || !items.length) return json(400, { error: 'empty cart' });
    const o = { id: orders.length + 1, items, status: 'NEW' }; orders.push(o); json(201, o); }); return; }
  const m = req.url.match(/^\/api\/orders\/(\d+)$/);
  if (m) { const o = orders.find((x) => x.id === +m[1]); return o ? json(200, o) : json(404, { error: 'not found' }); }
  json(404, { error: 'no route' });
}).listen(process.env.PORT || 4010, () => console.log('demo app on', process.env.PORT || 4010));
