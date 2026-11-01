# DusukMB Call: prototip v0.1

Tarayıcıdan, kurulum gerektirmeyen, **saatte ~50 MB** (tek yön) görüntülü görüşme.
Alıcı tarafta GPU ile 2x büyütme ve netleştirme yapılır.

## Test sonuçları (iki tarayıcı, profil başına 25 sn)

Rakamlar **telefon başına toplam** (gönderilen + alınan):

| Profil | Görüntü | Ölçülen hız (toplam) | Saatlik veri |
|---|---|---|---|
| **Normal** (varsayılan) | 240×180 @ 12 fps | ~105 kbps | **~47 MB** |
| İyi | 320×240 @ 15 fps | ~190 kbps | ~85 MB |
| Sadece ses | kamera kapalı | ~35 kbps | ~15 MB |

- Codec: VP9 (iPhone varsa H.264). Ses: Opus mono, 10 kbps, 60 ms paket (başlık yükü 3 kat az), sessizlikte veri kesilir.
- Alıcı telefon gelen 240×180 görüntüyü ekranda 3 kata kadar büyütüp netleştirir.
- Tarayıcılar videoyu 30 kbps altına indirmiyor; bu yüzden Normal'den düşüğü "Sadece ses".
- Profil bir tarafta değişince iki tarafta birden uygulanır.

## Canlı sürüm

GitHub Pages: `https://xoqxs.github.io/dusukmb-call/`. Sunucu gerekmez, sinyal için ücretsiz
PeerJS sunucusu (0.peerjs.com) kullanılır. İki telefondan aynı linki açıp aynı oda kodunu yazman yeterli.

## Dosyalar

```
public/                Web uygulaması (GitHub Pages'te bu klasör yayınlanır)
  index.html, app.js   Arayüz, WebRTC görüşme, profiller, istatistik
  enhance.js           Alıcı tarafta netleştirme (WebGL)
server.js              İsteğe bağlı: kendi sunucunda sayfa + PeerJS sinyal + TURN bilgisi
docker-compose.yml     Sunucuda: uygulama + HTTPS (Caddy) + TURN (coturn)
deploy/oracle-kurulum.sh   Oracle Cloud'da tek komutla kurulum
```

## 1) Kendi bilgisayarında dene (5 dakika)

Gerekli: [Node.js](https://nodejs.org) 18 veya üstü.

```bash
cd dusukmb-call
npm install
npm start
```

Tarayıcıda iki sekme aç: `http://localhost:3000/?oda=deneme`. İkisinde de "Görüşmeye katıl"a bas.
📊 düğmesi gerçek MB tüketimini gösterir.

## 2) Telefonla dene (bedava, sunucu yok)

Telefon kamerası sadece **HTTPS**'te açılır. Bilgisayarındaki uygulamayı bedava bir Cloudflare
tüneliyle internete açabilirsin (hesap gerekmez):

```bash
# cloudflared kur: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
npm start                                   # bir terminalde
cloudflared tunnel --url http://localhost:3000   # diğer terminalde
```

Çıktıda `https://xxxx.trycloudflare.com` gibi bir adres çıkar. İki telefondan bu adresi aç, aynı oda kodunu yaz.

⚠️ Bu modda TURN sunucusu yok. Ev Wi-Fi'si ve çoğu 4G hattında çalışır; bazı operatörlerde
ve gemi ağlarında bağlantı kurulamayabilir. O durumda 3. adıma geç.

## 3) Oracle Cloud'a kur (bedava, kalıcı, TURN dahil)

1. **Hesap aç:** [oracle.com/cloud/free](https://www.oracle.com/cloud/free/). Kredi kartı ister, para çekmez.
   Ana bölge olarak **Frankfurt** veya **Amsterdam** seç (Türkiye'ye yakın).
2. **Sunucu oluştur:** Compute → Instances → Create
   - Image: **Ubuntu 24.04** (aarch64)
   - Shape: **Ampere VM.Standard.A1.Flex**, 2 OCPU / 12 GB yeterli
   - SSH anahtarını indir
   - "Out of capacity" hatası alırsan birkaç saat sonra tekrar dene ya da başka bir availability domain seç.
3. **Portları aç (Oracle paneli):** Networking → VCN → Security List → Add Ingress Rules
   - Kaynak `0.0.0.0/0`, TCP: `80`, `443`, `3478`
   - Kaynak `0.0.0.0/0`, UDP: `3478`, `49160-49200`
4. **Dosyaları sunucuya gönder ve kur:**
   ```bash
   scp -i anahtar.key -r dusukmb-call ubuntu@SUNUCU_IP:~
   ssh -i anahtar.key ubuntu@SUNUCU_IP
   cd dusukmb-call
   bash deploy/oracle-kurulum.sh
   ```
   Betik Docker'ı kurar, sunucu içi güvenlik duvarını açar, `.env` dosyasını otomatik oluşturur
   (rastgele TURN şifresi + bedava `IP.sslip.io` alan adı) ve her şeyi başlatır.
5. Çıktıdaki `https://1-2-3-4.sslip.io` adresini telefondan aç. 📊 → "Bağlantı" satırında
   "TURN sunucusu üzerinden" görürsen TURN da çalışıyor demektir.

**Oracle'ın boşta kalan sunucuyu geri alması:** Ücretsiz sunucuların CPU kullanımı uzun süre çok
düşük kalırsa Oracle uyarı gönderip geri alabiliyor. Uyarı gelirse hesabı "Pay As You Go"ya
yükselt (ücretsiz limitler aynen kalır, ücret çıkmaz) ya da küçük bir zamanlanmış iş ekle.

**Alternatif TURN:** Coturn ile uğraşmak istemezsen Cloudflare Realtime TURN'ün ayda ilk 1.000 GB'ı bedava.

---

## Bilinen sınırlar (v0.1)

- **Netleştirme yapay zekâ değil:** Şu an GPU'da 2x büyütme + uyarlamalı keskinleştirme (CAS) yapılıyor.
  Tüm telefonlarda çalışır, ama sıkıştırma bloklarını tam temizlemez. v0.2'de ONNX Runtime Web ile
  küçük bir süper çözünürlük modeli denenecek; zayıf cihazda bu sürüme geri dönülecek.
- **Bildirim yok:** Arayan kişi linki WhatsApp/SMS ile gönderir, karşı taraf linke tıklar.
- **Ekran kapanınca** görüşme duraklayabilir (tarayıcı kısıtı). Mobil uygulamada çözülecek.
- **Giriş/hesap yok:** Oda kodunu bilen girer (oda başına en fazla 2 kişi). Oda kodlarını tahmin
  edilmesi zor seç (🔗 "Yeni oda oluştur" rastgele kod üretir).
- Gemi ağları genelde TCP 443 dışında her şeyi kapatır. Gerekirse TURN'ü TLS/443'e taşımak sonraki adım.

## Sonraki adımlar

1. İki telefonla gerçek ağda test (iPhone 7 Plus + Redmi Note 9), 10 dk görüşme, 📊 değerlerini kaydet.
2. Netleştirme açık/kapalı karşılaştırması: 5-10 kişiye "hangisi daha iyi?" diye sor.
3. v0.2: yapay zekâ modeli, TURN over TLS 443, basit giriş.
