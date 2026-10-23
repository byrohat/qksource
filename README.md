# qksource-onboard

Müşterinin CJ Dropshipping hesabı açıldıktan sonra operatör bu sayfaya CJ e-posta ve şifresini yazar. Uygulama headless Chromium ile `https://qksource.com/register.html` sayfasını açar. Robot doğrulaması çıkarsa kodu **kendisi çözmez**; resmi operatöre gösterir, operatörün yazdığı kodu ilgili alana basar ve siyah Submit'e tıklar. Ardından kayıt penceresindeki turuncu CJ ikonuna (WhatsApp'ın solundaki ilk sosyal ikon) tıklar, CJ sayfasında giriş yapar, izin ekranı varsa onaylar ve qksource'a dönüşü bekler.

Arayüz ve API ayrı bir uygulama şifresi istemez.

## Render'a kurulum
1. Render → **New → Blueprint** → bu repoyu seç (`render.yaml` otomatik okunur). Ya da **New → Web Service → Docker** seç.
2. Plan: en az **Starter** (Chromium için ücretsiz plan belleği yetmeyebilir).
3. Seçiciler ve adım zaman aşımları aşağıda. Canlı sitede ikon veya alan farklıysa kod değiştirmeden Render env ile düzeltin.
4. Deploy sonrası servis URL'ini açın, formu doldurup **Başlat**'a basın. Doğrulama resmi gelirse kodu yazıp **Gönder**'e basın.
5. Sağlık kontrolü `GET /healthz` (gövde `ok`). `render.yaml` bunu kullanır.

## Akış
1. `https://qksource.com/register.html` açılır.
2. "We would like to make sure you are not a robot" sayfası çıkarsa oturum durur. Yanıt `{status:"captcha", sessionId, image}` şeklindedir. `image`, doğrulama görselinin base64 PNG ekran görüntüsüdür. Sunucu OCR veya dış çözüm servisi kullanmaz.
3. Operatör kodu yazar. Arayüz `POST /onboard/:sessionId/captcha` ile `{code}` gönderir. Sunucu alanı doldurur ve Submit'e basar.
4. Kod yanlışsa veya sayfa yeniden doğrulama isterse aynı oturumda yeni bir `image` döner.
5. "Welcome to Qksource.com" kayıt penceresinde turuncu CJ ikonuna tıklanır. Varsayılan arama: `src` / `href` / `class` / `alt` içinde `cj` geçen öğe, yoksa WhatsApp ikonunun solundaki ilk sosyal ikon. `SEL_CJ_BUTTON` tanımlıysa yalnızca o seçici kullanılır.
6. CJ penceresi veya yönlendirmesinde e-posta ve şifre yazılır, giriş gönderilir, izin ekranı varsa onaylanır, başarı qksource sayfasında beklenir.
7. CJ tarafında da doğrulama kodu sayfası çıkarsa aynı duraklama kullanılır.

Tarayıcı oturumu bellekte `sessionId` ile durur. Son işlemden sonra yaklaşık **5 dakika** (`SESSION_TTL_MS`, varsayılan `300000`) içinde kapanır. Başarı veya hatada da kapanır. Aynı anda tek oturum çalışır.

## Adımlar
Hata olursa yanıt ve arayüz, başarısız adımı Türkçe söyler. Zaman aşımında mesajın sonuna `(zaman aşımı)` eklenir. Hata yanıtında `url` ve `screenshot` (base64 PNG) vardır.

| Adım | Ne yapar | Örnek hata |
| --- | --- | --- |
| 1 | Tarayıcıyı başlat | `Adım 1: Tarayıcı başlatılamadı` |
| 2 | Kayıt sayfasını aç | `Adım 2: Kayıt sayfası açılamadı (zaman aşımı)` |
| 3 | Doğrulama kodunu gönder | `Adım 3: Doğrulama kodu alanı bulunamadı` |
| 4 | CJ ikonuna tıkla | `Adım 4: CJ giriş ikonu bulunamadı` |
| 5 | Popup veya yönlendirmeyi algıla | `Adım 5: CJ penceresi veya yönlendirme algılanamadı` |
| 6 | E-postayı doldur | `Adım 6: CJ e-posta alanı bulunamadı` |
| 7 | Şifreyi doldur | `Adım 7: CJ şifre alanı bulunamadı` |
| 8 | Girişi gönder | `Adım 8: CJ giriş formu gönderilemedi` |
| 9 | Yetki ekranını onayla (yoksa atlanır) | `Adım 9: CJ yetki ekranı onaylanamadı` |
| 10 | Başarıyı bekle | `Adım 10: Giriş sonrası başarı ekranı gelmedi (zaman aşımı)` |

Ayrıca:

- Hatalı CJ bilgisi: `CJ kimlik bilgileri reddedildi` (`"blocker":"credentials"`)
- Zaman aşımı: mesajda `(zaman aşımı)`, `"blocker":"timeout"`
- Tarayıcı açılmazsa: `Adım 1: Tarayıcı başlatılamadı` (`"blocker":"browser"`)
- Doğrulama sayfası hata değildir; `status:"captcha"` ile durulur.

Kayıt sayfasını açma (adım 2) ve CJ sayfasının yüklenmesi (adım 5) geçici bir gezinme hatasına düşerse **bir kez** yeniden dener.

## API
`POST /onboard`, gövde: `{"cjEmail":"...","cjPassword":"..."}`

Doğrulama: `{"status":"captcha","sessionId":"...","image":"<base64 png>"}`

`POST /onboard/:sessionId/captcha`, gövde: `{"code":"..."}`  
Aynı üç yanıttan biri: yeni captcha, başarı veya hata.

Başarı: `{"ok":true,"status":"ok","url":"..."}`

Hata: `{"ok":false,"status":"error","error":"Adım 4: CJ giriş ikonu bulunamadı","step":"cj-button","url":"...","screenshot":"<base64 png>","blocker":null}`

Süresi dolmuş oturum: `404` ve `Oturum bulunamadı veya süresi doldu`.

`GET /healthz` → `200` ve `ok`.

## Seçiciler
Boş bırakılırsa varsayılan kullanılır. `QK_LOGIN_URL` tanımlıysa `SEL_LOGIN_URL` yok sayılır.

| Değişken | Neyi seçer | Varsayılan |
| --- | --- | --- |
| `QK_LOGIN_URL` | qksource kayıt adresi | `https://qksource.com/register.html` |
| `SEL_LOGIN_URL` | `QK_LOGIN_URL` yoksa kayıt adresi | aynı |
| `SEL_CJ_BUTTON` | CJ ikonu. Tanımlıysa otomatik arama yapılmaz | `src` / `href` / `class` / `alt` içinde `cj`, yoksa WhatsApp'ın solundaki ilk ikon |
| `SEL_CAPTCHA_IMAGE` | Doğrulama görseli | alanın hemen üstündeki `img` veya `canvas` |
| `SEL_CAPTCHA_INPUT` | Doğrulama kodu alanı | `placeholder` içinde "verification code" |
| `SEL_CAPTCHA_SUBMIT` | Doğrulama Submit butonu | `Submit` / `Gönder` yazan buton |
| `SEL_CAPTCHA` | Ek captcha seçici (reCAPTCHA vb.) | reCAPTCHA, hCaptcha, Turnstile |
| `SEL_CJ_EMAIL` | CJ e-posta alanı | `input[type="email"], input[name="email"], input[name="username"], input[placeholder*="mail" i]` |
| `SEL_CJ_PASSWORD` | CJ şifre alanı | `input[type="password"]` |
| `SEL_CJ_SUBMIT` | CJ giriş butonu | `button[type="submit"]` ve Sign in / Login |
| `SEL_CJ_AUTHORIZE` | CJ izin butonu | Authorize / Allow / Agree / Confirm / Yetki butonu |
| `SEL_SUCCESS` | qksource dönüşünde görünen yazı | `text=/Dashboard\|My Store\|Logout\|Sign out\|Log out\|Hesabım/i` |
| `SEL_ERROR_TEXT` | Hatalı bilgi metni | incorrect password, login failed, şifre hatalı ve benzeri |
| `SESSION_TTL_MS` | Oturumun açık kalma süresi | `300000` (5 dakika) |

## Adım zaman aşımları
Milisaniye. Geçersiz veya boşsa varsayılan kullanılır.

| Değişken | Adım | Varsayılan |
| --- | --- | --- |
| `TIMEOUT_OPEN_LOGIN` | 2, kayıt sayfası | `45000` |
| `TIMEOUT_CAPTCHA` | 3, kodu yazıp gönderme | `20000` |
| `TIMEOUT_CJ_BUTTON` | 4, CJ ikonu | `20000` |
| `TIMEOUT_POPUP` | 5, popup bekleme | `8000` |
| `TIMEOUT_NAVIGATION` | 5, açılan sayfanın yüklenmesi | `30000` |
| `TIMEOUT_EMAIL` | 6, e-posta | `30000` |
| `TIMEOUT_PASSWORD` | 7, şifre | `30000` |
| `TIMEOUT_SUBMIT` | 8, gönder | `30000` |
| `TIMEOUT_AUTHORIZE` | 9, yetki ekranı | `10000` |
| `TIMEOUT_SUCCESS` | 10, başarı | `45000` |

## Loglar
Her adım stdout'a tek satır JSON yazar (`step`, `stepNo`, `stepName`, `event`, `sessionId`, `url`, `message`). Duraklama `event:"pause"` ve `step:"captcha"` olarak görünür. CJ şifresi ve operatörün yazdığı doğrulama kodu loglanmaz; bir metne karışırsa `[REDACTED]` olur. Beklenmeyen süreç hataları `uncaughtException` / `unhandledRejection` olarak yazılır ve süreç kapanır.

## Dikkat
- Doğrulama kodu otomatik çözülmez. Resmi operatör okur.
- CJ ikonu bulunamazsa `SEL_CJ_BUTTON` ile Playwright seçicisini verin.
- Yetki ekranı her hesapta çıkmayabilir. Görünmezse adım 9 atlanır.
- Oturumlar yalnızca bu sürecin belleğindedir. Süre dolunca tarayıcı kapanır; kodu yeniden başlatmak gerekir.
