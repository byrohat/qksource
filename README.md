# qksource-onboard

Müşterinin CJ Dropshipping hesabı açıldıktan sonra operatör bu sayfaya CJ e-posta ve şifresini yazar. Uygulama headless Chromium ile `https://qksource.com/register.html` sayfasını açar. Robot doğrulaması çıkarsa kodu **kendisi çözmez**; resmi operatöre gösterir, operatörün yazdığı kodu ilgili alana basar ve siyah Submit'e tıklar. Ardından kayıt penceresindeki turuncu CJ ikonuna (WhatsApp'ın solundaki ilk sosyal ikon) tıklar, CJ sayfasında giriş yapar, izin ekranı varsa onaylar ve qksource'a dönüşü bekler.

Arayüz ve API ayrı bir uygulama şifresi istemez.

## Render'a kurulum
1. Render → **New → Blueprint** → bu repoyu seç (`render.yaml` otomatik okunur). Ya da **New → Web Service → Docker** seç.
2. Plan: en az **Starter** (Chromium için ücretsiz plan belleği yetmeyebilir).
3. Seçiciler, tarayıcı bölgesi ve adım zaman aşımları aşağıda. Canlı sitede ikon veya alan farklıysa kod değiştirmeden Render env ile düzeltin.
4. Frankfurt çıkışı "only accessible to European sites" sayfasını görürse `PROXY_URL` ile bir Avrupa proxy'si tanımlayın. Kontrol: `GET /debug/ip`.
5. Deploy sonrası servis URL'ini açın, formu doldurup **Başlat**'a basın. Doğrulama resmi gelirse kodu yazıp **Gönder**'e basın.
6. Sağlık kontrolü `GET /healthz` (gövde `ok`). `render.yaml` bunu kullanır.

## Akış
1. `https://qksource.com/register.html` açılır. Tarayıcı Avrupa yerel ayarıyla başlar: dil `BROWSER_LOCALE` (varsayılan `de-DE`), saat dilimi `BROWSER_TZ` (varsayılan `Europe/Berlin`), buna uyan `Accept-Language`, masaüstü Chrome kullanıcı aracısı (`BROWSER_UA` ile değiştirilebilir) ve 1366×768 pencere. `PROXY_URL` doluysa Chromium bu proxy ile çıkar.
2. Sayfa "only accessible to European sites" diyorsa CJ ikonuna geçilmez. Yanıt: `Adım 3: qksource bölge engeli (Avrupa dışı erişim). PROXY_URL ile Avrupa proxy'si tanımlayın.`
3. "We would like to make sure you are not a robot" sayfası çıkarsa oturum durur. Yanıt `{status:"captcha", sessionId, image}` şeklindedir. `image`, doğrulama görselinin base64 PNG ekran görüntüsüdür. Ekran görüntüsü, `img` `complete` olana ve `naturalWidth > 0` olana kadar beklenir; kısa bir gecikmeden sonra alınır. Görsel boşsa resme veya yenile bağlantısına tıklanıp bir kez daha denenir. Sunucu OCR veya dış çözüm servisi kullanmaz.
4. Operatör kodu yazar. Arayüz `POST /onboard/:sessionId/captcha` ile `{code}` gönderir. Sayfada Cloudflare Turnstile varsa sunucu, kendi `cf-turnstile-response` alanı dolana kadar en fazla `TIMEOUT_TURNSTILE` (varsayılan 30 sn) bekler; jetonu üretmez ve çözmez. Sonra kodu yazar, Submit'e basar. Başarı için doğrulama izlerinin kalkması gerekir: `#verifyCode` yok, `meta[name=validation]` yok, başlık "Human verification" değil. Kayıt formu da durmalıdır (Welcome to Qksource, Create a Qksource account, Confirm Password veya WhatsApp satırı). Adres `register.html` kalsa bile izler duruyorsa kod yanlış veya bitmemiş sayılır ve yeni `image` döner. Yol doğrulama sayfasından çıkıp yeni sayfa doğrulama değilse (örneğin CJ giriş formu) akış sürer. Geçiş sırasında oluşan "Execution context was destroyed" yüzünden akış düşmez.
5. Kod yanlışsa veya sayfa yeniden doğrulama isterse aynı oturumda yeni bir `image` döner.
6. "Welcome to Qksource.com" kayıt penceresinde turuncu CJ ikonuna tıklanır. İkon, yalnızca sosyal giriş satırında, WhatsApp ile aynı hizada ve onun solundaki simgedir (`src` / `href` / `class` / `alt` içinde `cj` varsa o tercih edilir). `#verifyCode` ve doğrulama sayfasının içindeki öğeler seçilmez. WhatsApp satırı yokken sayfadaki rastgele `cj` yazısına düşülmez. Sayfa hâlâ insan doğrulamasındaysa yeni resim döner, ikona tıklanmaz. `SEL_CJ_BUTTON` tanımlıysa o seçici kullanılır; yine de `#verifyCode` veya doğrulama yerleşimine oturursa tıklanmaz.
7. Sosyal girişten önce, metni agree / terms / privacy / policy / sözleş / gizlilik / onay olan işaretlenmemiş bir kutu varsa işaretlenir.
8. CJ ikonuna sırayla beş deneme yapılır. Her denemeden sonra en fazla `TIMEOUT_CJ_CLICK` (varsayılan 20 sn) popup, adres değişimi veya iframe beklenir: öğeye normal tıklama, üst `<a>` veya butona tıklama, `element.click()`, `href` varsa o adrese gitme, sayfa betiğinde `cjdropshipping` / `oauth` / `authorize` ile kurulmuş bir adres varsa ona gitme. `href` yoksa, `#` ise veya betikte böyle bir adres yoksa o deneme atlanır. Hangisi gelirse CJ girişi orada yapılır. E-posta/kullanıcı adı ve şifre yazılır, giriş gönderilir, izin düğmesi varsa tıklanır, dönüş qksource ana sayfasında beklenir.
9. CJ yüzeyi bulunamazsa hata ve log, tıklamadan önce alınan sosyal ikon satırının ve seçilen öğenin HTML'ini (etiket, href, onclick, data-*), deneme sırasında biriken konsol mesajlarını ve başarısız istekleri, açık sayfaların adreslerini ve her sayfanın ekran görüntüsünü içerir. Popup `chrome-error` adresine düşerse hedeflenen adres en fazla 3 kez yeniden açılır. Hata metninde bu adres `popup hedef:` ile yazılır.
10. CJ tarafında da doğrulama kodu sayfası çıkarsa aynı duraklama kullanılır.

Tarayıcı oturumu bellekte `sessionId` ile durur. Son işlemden sonra yaklaşık **5 dakika** (`SESSION_TTL_MS`, varsayılan `300000`) içinde kapanır. Başarı veya hatada da kapanır. Aynı anda tek oturum çalışır.

## Adımlar
Hata olursa yanıt ve arayüz, başarısız adımı Türkçe söyler. Zaman aşımında mesajın sonuna `(zaman aşımı)` eklenir. Hata yanıtında `url`, her açık sayfanın ekran görüntüsü (`screenshots`) ve özgün Playwright metni (`detail`, açık sayfa ve çerçeve adresleriyle) vardır. Adım sarmalayıcısının dışında kalan bir hata da genel bir metne düşmez; `Adım N: ad adı: <err.message>` olarak döner.

| Adım | Ne yapar | Örnek hata |
| --- | --- | --- |
| 1 | Tarayıcıyı başlat | `Adım 1: Tarayıcı başlatılamadı` |
| 2 | Kayıt sayfasını aç | `Adım 2: Kayıt sayfası açılamadı (zaman aşımı)` |
| 3 | Doğrulama kodunu gönder. CJ ikonundan önce bölge duvarı da burada raporlanır | `Adım 3: Doğrulama kodu alanı bulunamadı` |
| 4 | CJ ikonuna tıkla | `Adım 4: CJ giriş ikonu bulunamadı` |
| 5 | Sözleşme kutusu, sonra popup / yönlendirme / iframe. Olmazsa öğe HTML'i, konsol ve başarısız istekler | `Adım 5: CJ penceresi veya yönlendirme algılanamadı` |
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
- Avrupa dışı erişim sayfası, CJ ikonuna (adım 4) geçilmeden: `Adım 3: qksource bölge engeli (Avrupa dışı erişim). PROXY_URL ile Avrupa proxy'si tanımlayın.` (`"step":"geo"`, `"blocker":"geo"`)

Kayıt sayfasını açma (adım 2) geçici bir gezinme hatasına düşerse **bir kez** yeniden dener. CJ popup'ı `chrome-error://chromewebdata/` olursa hedeflenen URL en fazla 3 kez `goto` veya `reload` ile yeniden açılır (`TIMEOUT_CJ_NAVIGATION`).

Proxy yavaşsa gereksiz üçüncü taraf istekleri kesilir: Google GSI (`accounts.google.com/gsi`), Facebook SDK (`connect.facebook.net`), analitik (Google Analytics, Tag Manager, DoubleClick, Hotjar, Segment, Mixpanel), yazı tipleri ve captcha olmayan resimler. `yesourcing.com` ile CJ `Country.json` de kesilir. Belge istekleri, `challenges.cloudflare.com` / Turnstile, captcha veya verify resimleri, qksource ve yerel (`127.0.0.1`) resimler açık kalır. Kesilen istekler tıklama izine yazılmaz.

## API
`POST /onboard`, gövde: `{"cjEmail":"...","cjPassword":"..."}`

Doğrulama: `{"status":"captcha","sessionId":"...","image":"<base64 png>"}`

`POST /onboard/:sessionId/captcha`, gövde: `{"code":"..."}`  
Aynı üç yanıttan biri: yeni captcha, başarı veya hata.

Başarı: `{"ok":true,"status":"ok","url":"..."}`

Hata: `{"ok":false,"status":"error","error":"Adım 4: CJ giriş ikonu bulunamadı","step":"cj-button","url":"...","screenshot":"<base64 png>","blocker":null}`

Süresi dolmuş oturum: `404` ve `Oturum bulunamadı veya süresi doldu`.

`GET /healthz` → `200` ve `ok`.

`GET /debug/ip` aynı tarayıcı ve proxy ile `https://ipapi.co/json` okur. Başarı: `{"ip":"...","country":"Germany","countryCode":"DE"}`. Proxy şifresi yanıtta ve logda yoktur. Onboard sürerken `429` döner.

## Seçiciler
Boş bırakılırsa varsayılan kullanılır. `QK_LOGIN_URL` tanımlıysa `SEL_LOGIN_URL` yok sayılır.

| Değişken | Neyi seçer | Varsayılan |
| --- | --- | --- |
| `QK_LOGIN_URL` | qksource kayıt adresi | `https://qksource.com/register.html` |
| `SEL_LOGIN_URL` | `QK_LOGIN_URL` yoksa kayıt adresi | aynı |
| `SEL_CJ_BUTTON` | CJ ikonu. Tanımlıysa otomatik arama yapılmaz. `#verifyCode` ve doğrulama yerleşimi yine de elenir | sosyal satırda WhatsApp'ın solundaki ikon (`cj` yazısı varsa o) |
| `SEL_CAPTCHA_IMAGE` | Doğrulama görseli | alanın hemen üstündeki `img` veya `canvas` |
| `SEL_CAPTCHA_INPUT` | Doğrulama kodu alanı | `placeholder` içinde "verification code" |
| `SEL_CAPTCHA_SUBMIT` | Doğrulama Submit butonu | `Submit` / `Gönder` yazan buton |
| `SEL_CAPTCHA` | Ek captcha seçici (reCAPTCHA vb.) | reCAPTCHA, hCaptcha. Turnstile insan kodu sayılmaz; kendi jetonu beklenir |
| `SEL_CJ_EMAIL` | CJ e-posta alanı (popup, yönlendirme veya iframe içinde) | `input[type="email"]`, `username`, `account`, placeholder içinde mail/user |
| `SEL_CJ_PASSWORD` | CJ şifre alanı | `input[type="password"]` |
| `SEL_CJ_SUBMIT` | CJ giriş butonu | `button[type="submit"]` ve Sign in / Login |
| `SEL_CJ_AUTHORIZE` | CJ izin butonu | Authorize / Allow / Agree / Confirm / Yetki butonu |
| `SEL_SUCCESS` | qksource dönüşünde görünen yazı | `text=/Dashboard\|My Store\|Logout\|Sign out\|Log out\|Hesabım/i` |
| `SEL_ERROR_TEXT` | Hatalı bilgi metni | incorrect password, login failed, şifre hatalı ve benzeri |
| `BROWSER_LOCALE` | Tarayıcı dili ve `Accept-Language` | `de-DE` (`de-DE,de;q=0.9,en;q=0.8`) |
| `BROWSER_TZ` | IANA saat dilimi | `Europe/Berlin` |
| `BROWSER_UA` | Kullanıcı aracısı. Boşsa masaüstü Chrome (HeadlessChrome değil) | boş |
| `PROXY_URL` | Chromium proxy'si | yok. `http://kullanıcı:şifre@host:port` veya `socks5://...` |
| `SESSION_TTL_MS` | Oturumun açık kalma süresi | `300000` (5 dakika) |

## Adım zaman aşımları
Milisaniye. Geçersiz veya boşsa varsayılan kullanılır. `PROXY_URL` doluysa ve ilgili değişken boşsa varsayılan **3 katına** çıkar (proxy yavaştır). `TIMEOUT_CJ_CLICK` buna girmez; boşsa 20000 kalır. `TIMEOUT_TURNSTILE` de girmez; boşsa 30000 kalır. `TIMEOUT_CJ_NAVIGATION` boşsa proxy varken 90000, yokken 45000 olur; proxy bunu bir daha 3 katına çıkarmaz. Değişkeni elle verirseniz o değer kullanılır.

| Değişken | Adım | Varsayılan |
| --- | --- | --- |
| `TIMEOUT_OPEN_LOGIN` | 2, kayıt sayfası | `45000` |
| `TIMEOUT_CAPTCHA` | 3, kodu yazıp gönderme | `20000` |
| `TIMEOUT_CJ_BUTTON` | 4, CJ ikonu | `20000` |
| `TIMEOUT_CJ_CLICK` | 5, her tıklama denemesinden sonra popup, yönlendirme veya iframe | `20000`. Bu değişken proxy ile 3 katına çıkmaz |
| `TIMEOUT_CJ_NAVIGATION` | 5, CJ popup'ını açma ve `chrome-error` sonrası yeniden deneme | proxy yoksa `45000`, proxy varsa `90000`. Elle verilirse o değer. Proxy ile tekrar 3 katına çıkmaz |
| `TIMEOUT_TURNSTILE` | 3, Turnstile'ın kendi jetonunu yazması | `30000`. Bu değişken proxy ile 3 katına çıkmaz |
| `TIMEOUT_POPUP` | Eski adım 5 beklemesi. Yeni akış `TIMEOUT_CJ_CLICK` kullanır | `8000` |
| `TIMEOUT_NAVIGATION` | Sayfa yüklenmesi | `30000` |
| `TIMEOUT_EMAIL` | 6, e-posta | `30000` |
| `TIMEOUT_PASSWORD` | 7, şifre | `30000` |
| `TIMEOUT_SUBMIT` | 8, gönder | `30000` |
| `TIMEOUT_AUTHORIZE` | 9, yetki ekranı | `10000` |
| `TIMEOUT_SUCCESS` | 10, başarı | `45000` |

## Loglar
Her adım stdout'a tek satır JSON yazar (`step`, `stepNo`, `stepName`, `event`, `sessionId`, `url`, `message`). Duraklama `event:"pause"` ve `step:"captcha"` olarak görünür. CJ ikonu bulununca `event:"markup"` satırı, tıklamadan önce ikon satırının ve seçilen öğenin HTML'ini yazar. Adım 5 hata satırı aynı HTML'i, konsol mesajlarını, başarısız istekleri ve popup `chrome-error` olduysa `popup hedef:` adresini de taşır. Popup yeniden denenince `event:"popup-retry"` yazılır. Kesilen üçüncü taraf adresi `event:"block"` ile bir kez loglanır. CJ şifresi ve operatörün yazdığı doğrulama kodu loglanmaz; bir metne karışırsa `[REDACTED]` olur. Beklenmeyen süreç hataları `uncaughtException` / `unhandledRejection` olarak yazılır ve süreç kapanır.

## Dikkat
- Doğrulama kodu otomatik çözülmez. Resmi operatör okur.
- Bölge sayfası IP'ye bakar. Dil ve saat dilimi her açılışta Avrupa'ya ayarlanır; duvar sürerse `PROXY_URL` gerekir. `GET /debug/ip` ülke kodunu gösterir.
- CJ ikonu bulunamazsa `SEL_CJ_BUTTON` ile Playwright seçicisini verin.
- Yetki ekranı her hesapta çıkmayabilir. Görünmezse adım 9 atlanır.
- Oturumlar yalnızca bu sürecin belleğindedir. Süre dolunca tarayıcı kapanır; kodu yeniden başlatmak gerekir.
