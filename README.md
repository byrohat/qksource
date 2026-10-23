# qksource-onboard

Müşterinin CJ Dropshipping hesabı açıldıktan sonra, operatör bu uygulamanın arayüzüne CJ e-posta/kullanıcı adı ve şifresini girer; uygulama headless Chromium ile qksource.com'a gidip **Login via CJ** ile giriş yapar, izin ekranını onaylar ve sonucu (başarılı + son URL ya da hata + ekran görüntüsü) gösterir.

## Render'a kurulum
1. Render → **New → Blueprint** → bu repoyu seç (`render.yaml` otomatik okunur). Ya da **New → Web Service → Docker** seç.
2. Plan: en az **Starter** (Chromium için ücretsiz plan belleği yetmeyebilir).
3. Ortam değişkenleri:
   - `APP_PASSWORD` (zorunlu): arayüz ve API şifresi. Tarayıcı kullanıcı adı sorar (herhangi bir şey yazın), şifre olarak bunu girin.
   - `QK_LOGIN_URL` (isteğe bağlı): qksource login sayfası farklıysa.
4. Deploy sonrası servis URL'ini açın, formu doldurup **Başlat**'a basın.

## API
`POST /onboard` (Basic auth, şifre = APP_PASSWORD), gövde: `{"cjEmail":"...","cjPassword":"..."}`
Yanıt: `{"ok":true,"url":"..."}` veya `{"ok":false,"error":"...","screenshot":"<base64 png>"}`

## Dikkat
- `server.js` içindeki `SEL` seçicileri tahminidir; canlı sitedeki gerçek buton/alanlara göre doğrulayın.
- CJ girişte 2FA, e-posta kodu veya captcha çıkarsa otomasyon takılır; hata ekran görüntüsünden görebilirsiniz.
- CJ şifreleri loglanmaz ve saklanmaz. Aynı anda tek işlem çalışır.
