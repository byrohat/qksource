# qksource-onboard

Müşterinin CJ Dropshipping hesabı açıldıktan sonra, operatör bu uygulamanın arayüzüne CJ e-posta/kullanıcı adı ve şifresini girer; uygulama headless Chromium ile qksource.com'a gidip **Login via CJ** ile giriş yapar, izin ekranını onaylar ve sonucu (başarılı + son URL ya da hata + ekran görüntüsü) gösterir.

## Render'a kurulum
1. Render → **New → Blueprint** → bu repoyu seç (`render.yaml` otomatik okunur). Ya da **New → Web Service → Docker** seç.
2. Plan: en az **Starter** (Chromium için ücretsiz plan belleği yetmeyebilir).
3. Seçiciler ve adım zaman aşımları aşağıda. Canlı sitede buton veya alan farklıysa kod değiştirmeden Render env ile düzeltin. Arayüz ve API şifre istemez.
4. Deploy sonrası servis URL'ini açın, formu doldurup **Başlat**'a basın.
5. Sağlık kontrolü `GET /healthz` (gövde `ok`). `render.yaml` bunu kullanır.

## Adımlar
Hata olursa yanıt ve arayüz, başarısız adımı Türkçe söyler. Zaman aşımında mesajın sonuna `(zaman aşımı)` eklenir. Yanıtta `url` (o anki sayfa) ve `screenshot` (base64 PNG) da vardır.

| Adım | Ne yapar | Örnek hata |
| --- | --- | --- |
| 1 | Tarayıcıyı başlat | `Adım 1: Tarayıcı başlatılamadı` |
| 2 | Login sayfasını aç | `Adım 2: Login sayfası açılamadı (zaman aşımı)` |
| 3 | CJ giriş butonuna tıkla | `Adım 3: CJ giriş butonu bulunamadı` |
| 4 | Popup veya yönlendirmeyi algıla | `Adım 4: CJ penceresi veya yönlendirme algılanamadı` |
| 5 | E-postayı doldur | `Adım 5: CJ e-posta alanı bulunamadı` |
| 6 | Şifreyi doldur | `Adım 6: CJ şifre alanı bulunamadı` |
| 7 | Girişi gönder | `Adım 7: CJ giriş formu gönderilemedi` |
| 8 | Yetki ekranını onayla (yoksa atlanır) | `Adım 8: CJ yetki ekranı onaylanamadı` |
| 9 | Başarıyı bekle | `Adım 9: Giriş sonrası başarı ekranı gelmedi (zaman aşımı)` |

Ayrıca şu engeller açıkça yazılır:

- Hatalı CJ bilgisi veya CJ sayfasındaki hata metni: `CJ kimlik bilgileri reddedildi`
- Captcha veya doğrulama kodu: `Captcha veya doğrulama kodu sayfası algılandı`
- Zaman aşımı: mesajda `(zaman aşımı)`, JSON alanında `"blocker":"timeout"`
- Tarayıcı açılmazsa: `Adım 1: Tarayıcı başlatılamadı` (`"blocker":"browser"`)

Login sayfasını açma (adım 2) ve CJ sayfasının yüklenmesi (adım 4) geçici bir gezinme hatasına düşerse (bağlantı koptu, `net::ERR_*`, zaman aşımı) **bir kez** yeniden dener. İkinci deneme de düşerse o adımın hatası döner.

## API
`POST /onboard`, gövde: `{"cjEmail":"...","cjPassword":"..."}`

Başarı: `{"ok":true,"url":"..."}`

Hata:

```json
{"ok":false,"error":"Adım 3: CJ giriş butonu bulunamadı","step":"cj-button","url":"https://www.qksource.com/login","screenshot":"<base64 png>","blocker":null}
```

`blocker` şunlardan biri olabilir: `captcha`, `credentials`, `timeout`, `browser`, `selector`, ya da `null`.

`GET /healthz` → `200` ve `ok`.

## Seçiciler
Hepsi Playwright seçicisidir. Boş bırakılırsa varsayılan kullanılır. `QK_LOGIN_URL` tanımlıysa `SEL_LOGIN_URL` yok sayılır.

| Değişken | Neyi seçer | Varsayılan |
| --- | --- | --- |
| `QK_LOGIN_URL` | qksource login adresi | `https://www.qksource.com/login` |
| `SEL_LOGIN_URL` | `QK_LOGIN_URL` yoksa login adresi | aynı |
| `SEL_CJ_BUTTON` | Login via CJ butonu | `text=/Login via CJ\|CJ/i` |
| `SEL_CJ_EMAIL` | CJ e-posta / kullanıcı alanı | `input[type="email"], input[name="email"], input[name="username"], input[placeholder*="mail" i]` |
| `SEL_CJ_PASSWORD` | CJ şifre alanı | `input[type="password"]` |
| `SEL_CJ_SUBMIT` | CJ giriş gönderme butonu | `button[type="submit"], button:has-text("Sign in"), button:has-text("Login")` |
| `SEL_CJ_AUTHORIZE` | CJ izin ekranı butonu | `text=/Authorize\|Allow\|Agree\|Confirm\|Yetki/i` |
| `SEL_SUCCESS` | Giriş sonrası görünen yazı | `text=/Dashboard\|My Store\|Welcome\|Logout/i` |
| `SEL_ERROR_TEXT` | Hatalı bilgi metni | `text=/incorrect password\|wrong password\|invalid password\|invalid credentials\|login failed\|account or password\|username or password\|şifre hatalı\|şifre yanlış\|hatalı şifre\|密码错误\|账号或密码\|用户名或密码/i` |
| `SEL_CAPTCHA` | Captcha / doğrulama (tek seçici; varsayılan listeyi tamamen değiştirir) | reCAPTCHA, hCaptcha, Turnstile iframe'leri ve captcha / verification code / doğrulama kodu metni |

## Adım zaman aşımları
Milisaniye. Geçersiz veya boşsa varsayılan kullanılır.

| Değişken | Adım | Varsayılan |
| --- | --- | --- |
| `TIMEOUT_OPEN_LOGIN` | 2, login sayfasını aç | `45000` |
| `TIMEOUT_CJ_BUTTON` | 3, CJ butonunu bul ve tıkla | `20000` |
| `TIMEOUT_POPUP` | 4, popup bekleme | `8000` |
| `TIMEOUT_NAVIGATION` | 4, açılan sayfanın yüklenmesi | `30000` |
| `TIMEOUT_EMAIL` | 5, e-posta | `30000` |
| `TIMEOUT_PASSWORD` | 6, şifre | `30000` |
| `TIMEOUT_SUBMIT` | 7, gönder | `30000` |
| `TIMEOUT_AUTHORIZE` | 8, yetki ekranı | `10000` |
| `TIMEOUT_SUCCESS` | 9, başarı | `45000` |

## Loglar
Her adım stdout'a tek satır JSON yazar (`step`, `stepNo`, `stepName`, `event`, `url`, `message`). Render loglarında hata `event:"fail"` ve adım adıyla görünür. CJ şifresi loglanmaz ve saklanmaz; bir hata metnine veya URL'ye karışırsa `[REDACTED]` olur. Aynı anda tek işlem çalışır. Beklenmeyen süreç hataları `uncaughtException` / `unhandledRejection` olarak yazılır ve süreç kapanır; Render yeniden başlatır.

## Dikkat
- Varsayılan seçiciler tahminidir. Canlı buton veya alan uyuşmazsa yukarıdaki env değişkenlerini güncelleyin; yeniden deploy yeter, kod değişmez.
- Captcha, e-posta kodu veya 2FA çıkarsa otomasyon durur ve hangi adımda takıldığını yazar. Ekran görüntüsünden de görebilirsiniz.
- Yetki ekranı her hesapta çıkmayabilir. Görünmezse adım 8 atlanır.
