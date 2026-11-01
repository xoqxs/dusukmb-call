// DusukMB Call - kendi sunucunda çalıştırmak için (isteğe bağlı)
// Web sayfası GitHub Pages'te sunucusuz da çalışır (ücretsiz PeerJS sinyal sunucusunu kullanır).
// Bu dosya: sayfayı + kendi PeerJS sinyal sunucunu + TURN kimlik bilgisini tek yerde sunar.
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { ExpressPeerServer } = require('peer');

const PORT = process.env.PORT || 3000;
const TURN_SECRET = process.env.TURN_SECRET || '';  // coturn static-auth-secret ile aynı
const TURN_HOST = process.env.TURN_HOST || '';      // sunucunun genel IP'si

const app = express();
const server = http.createServer(app);

// Zamanla sınırlı TURN kimlik bilgisi (coturn "use-auth-secret" modu)
function iceServers() {
  const list = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (TURN_SECRET && TURN_HOST) {
    const username = `${Math.floor(Date.now() / 1000) + 12 * 3600}:dusukmb`;
    const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
    list.push({ urls: [`turn:${TURN_HOST}:3478?transport=udp`, `turn:${TURN_HOST}:3478?transport=tcp`], username, credential });
  }
  return list;
}

// İstemci bu dosyayı okur: sinyal sunucusu olarak bu sunucuyu, TURN olarak coturn'ü kullanır
app.get('/config.json', (req, res) => {
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.secure;
  res.set('Cache-Control', 'no-store').json({
    signal: { host: req.hostname, port: Number(req.headers['x-forwarded-port']) || (secure ? 443 : PORT), secure, path: '/signal', key: 'peerjs' },
    iceServers: iceServers(),
  });
});
app.get('/health', (req, res) => res.send('ok'));
app.use('/signal', ExpressPeerServer(server, { path: '/', proxied: true, alive_timeout: 60000 }));
app.use(express.static(path.join(__dirname, 'public')));

server.listen(PORT, () => {
  console.log(`DusukMB Call çalışıyor: http://localhost:${PORT}`);
  console.log(TURN_SECRET && TURN_HOST ? `TURN: ${TURN_HOST}:3478` : 'TURN kapalı (sadece STUN)');
});
