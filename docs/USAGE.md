# AgentOS — Kullanım Kılavuzu (Manus-paritesi özellikleri)

Bu doküman, Manus incelemesi sonrası eklenen tüm özelliklerin **nasıl kullanılacağını** anlatır.
Her şey web arayüzünden (ve masaüstü uygulamasından) çalışır.

> Anahtar gerektiren özellikler (görsel/ses üretimi) için anahtarını **Ayarlar panellerine** yapıştırırsın;
> anahtar sunucuda şifrelenir, frontend'e hiç düşmez, geri okunamaz.

---

## 1) Görev oluşturma + yetenek modları (Capability chips)

Ana ekrandaki yazı kutusunun altında **çip** sırası vardır. Bir çip seçip görevini yaz → "Run task".
Çip, ajanı o tür **çıktıyı üretmeye** yönlendirir (Manus'un "Slaytlar/Web sitesi/..." modları):

| Çip | Ne üretir | Çıktı |
|---|---|---|
| **Agent** | Tam otonom ajan (varsayılan) | Duruma göre |
| **Chat** | Araçsız hızlı sohbet/Q&A | Metin |
| **Slides** | Sunum destesi | `.html` (gezilebilir) |
| **Document** | Rapor/makale | `.html` + `.md` |
| **Website** | Çok sayfalı statik site | `deliverables/<ad>/index.html` |
| **Spreadsheet** | Tablo/veri | `.csv` (Excel'de açılır) + HTML önizleme |
| **Chart** | Grafik | `.svg` (bar/çizgi/pasta) |
| **Image** | Görsel üretimi* | `.png`/`.svg` |
| **Audio** | Seslendirme (TTS)* | `.mp3`/`.wav` |

\* Image/Audio için önce **Media** ayarından bir sağlayıcı yapılandırman gerekir (bkz. §8).

Çıktılar görev detayındaki **Files** bölümünde listelenir; HTML/SVG/görseller **yerinde önizlenir**,
ses dosyaları **inline oynatıcı** ile çalar.

---

## 2) Efor katmanı (Lite / Pro / Max)

Yazı kutusunun altındaki **Effort** açılır menüsü, görevin akıl yürütme derinliğini seçer
(maliyet/kalite dengesi — Manus'un Lite/Pro/Max'i):

- **Low** → en ucuz/hızlı · **Medium** · **High** (varsayılan) · **Max** → en derin/pahalı.

Seçim göreve özeldir; Wide Research alt-ajanları da aynı katmanı miras alır.

---

## 3) Sesli giriş (🎤)

Yazı kutusunun yanındaki **🎤** düğmesi (tarayıcı destekliyorse görünür) konuşmanı metne çevirip
prompt'a ekler. Tıkla → konuş → otomatik durur (tekrar tıklayınca iptal). Anahtar gerekmez.

---

## 4) Görev yönetimi (yeniden adlandır / favori / arşiv / sil / zamanla)

Görev listesinde bir satırın üzerine gelince sağda aksiyonlar çıkar:

- **★** (soldaki yıldız) — favori; favoriler listenin başına sabitlenir.
- **Schedule** — görevin prompt'unu **tekrarlayan bir otomasyona** çevirir (günlük/hafta içi/saatlik
  preset veya özel cron; senin yerel saat diliminde). → "Planlanmış/Automations" altında çalışır.
- **Rename** — başlığı değiştir.
- **Archive / Unarchive** — varsayılan listeden gizle. Üstteki **Archived** geçişiyle arşivi gör.
- **Delete** — sil (çalışan görev silinemez; önce durdur).

---

## 5) Global arama / komut paleti (⌘/Ctrl + K)

Her yerden **Cmd/Ctrl + K** (veya liste başlığındaki "Search ⌘K") ile paleti aç:

- Başlık + prompt içinde arama (arşiv dahil), zaman gruplu sonuçlar.
- **↑/↓** ile gez, **Enter** ile aç, **Esc** ile kapat.
- En üstteki **"Start new task: …"** satırı, yazdığın metinle yeni görev başlatır.

---

## 6) Kişiselleştirme (Personalization) — header → "Personalize"

Ajanı **tüm görevlerde** yönlendiren her-zaman-açık bağlam (Manus'un "Kişiselleştirme"si):

- **Name / Profession / About** — profil.
- **Custom instructions** — ör. "Her zaman Türkçe yanıt ver."
- **Remembered facts** — ajanın hatırlamasını istediğin kısa notlar (ekle/çıkar).

Kaydedilince her görevin sistem prompt'una eklenir. (Yazma yetkisi **admin**; okuma viewer.)

---

## 7) Kütüphane (Library) — header → "Library"

Tüm görevlerdeki **çıktıların tek galeride** toplandığı yer (Manus'un "Kütüphane"si):

- Dosya adı/görev üzerinde **arama**, göreve göre gruplama.
- Görseller inline önizlenir, HTML çıktılar güvenli iframe'de **Preview** edilir, hepsi indirilebilir.

---

## 8) Medya üretimi (görsel + ses) — header → "Media"

Manus'un "Tasarım/Görsel" ve "Ses" yetenekleri. **Önce sağlayıcı yapılandır**, sonra ajan kullanır.

**Görsel sağlayıcı:**
- `openai` → model `gpt-image-1` (varsayılan) veya `dall-e-3`. Anahtar: OpenAI API key.
- `gemini` → model `imagen-3.0-generate-002`. Anahtar: Google AI Studio key.
- `mock` → anahtarsız test (basit SVG üretir, gerçek sanat değil).

**Ses sağlayıcı (TTS):**
- `openai` → model `tts-1`/`tts-1-hd`, ses `alloy` vb. Anahtar: OpenAI API key.
- `mock` → anahtarsız test (sessiz WAV).

**Adımlar:** Header → **Media** → Image/Speech bölümünde sağlayıcıyı seç, anahtarını yapıştır
(opsiyonel model/ses), **Save**. Artık:
- **Image**/**Audio** çiplerini kullanabilir veya görevde "bir görsel oluştur / şunu seslendir" diyebilirsin.
- Ajan `generate_image` / `generate_speech` araçlarını çağırır; çıktı **Files**'ta önizlenir/indirilir.

> Güvenlik: Anahtar şifreli saklanır, asla geri döndürülmez. OpenAI-uyumlu özel `baseUrl` verirsen
> sunucu onu **SSRF guard**'dan geçirir (iç/loopback adresler reddedilir).

---

## 9) Dosya-diff görünümü (computer panel)

Ajan bir dosyayı `fs_write` ile **düzenlediğinde**, görev detayındaki **Tool calls** bölümünde ham
JSON yerine **önceki/sonraki satır diff'i** (+/− renkli) gösterilir (Manus'un "Manus'in Bilgisayarı"
dosya-diff'i gibi). Yeni dosya "new file", düzenleme "edited" rozetiyle + ekle/sil sayısıyla görünür.

---

## 10) Canlı görev ilerlemesi (checklist)

Ajan kendi planını **canlı** günceller: görev detayındaki **Plan** bölümünde her adım
⏳ devam ediyor / ✓ tamam / ✗ başarısız durumuyla görünür (Manus'un "Görev ilerlemesi"). Ajan
`update_plan` aracını kullanarak checklist'i akış boyunca günceller.

---

## 11) Konnektörler — GitHub (header → "Connectors")

Üçüncü-parti hesap bağlama (Manus'un "Eklentiler"i). **GitHub** ilk konnektör; çerçeve Gmail/Drive/
Notion'a genişler. Kurulum (tek seferlik, admin):

1. GitHub'da bir **OAuth App** aç (Settings → Developer settings → OAuth Apps → New).
2. **Authorization callback URL** = Connectors panelinde gösterilen adres (`<API>/connectors/github/callback`).
3. App'in **Client ID** + **Client Secret**'ini panele yapıştır → "Save app" (şifreli saklanır).
4. **Connect GitHub** → GitHub onay ekranı → döndüğünde "Connected · <login>".

Bağlandıktan sonra ajan `github_list_repos` / `github_get_file` / `github_search_code` araçlarını
kullanır (görevde "repolarımı listele", "şu dosyayı oku" vb.). "Disconnect" ile bağlantıyı kaldır.

## 12) Mail → görev (header → "Mail")

Gelen e-postayı göreve çevir (Manus'un "Mail Manus"u). Kurulum (admin):

1. **Mail** panelini aç → bir **webhook URL'i** gösterilir (`<API>/inbound-email/<token>`).
2. Bir inbound-email servisi (Postmark / SendGrid / Mailgun …) yapılandır: gelen postayı parse edip
   bu URL'e **POST** etsin (alanlar: `from`, `subject`, `text` — yaygın varyantlar da kabul edilir).
3. Güvenlik: **Allowed senders** listesine izinli gönderenleri yaz (boş bırakma — herkes görev açabilir);
   şüphede **Rotate** ile token'ı döndür.

Artık o adrese gelen her e-posta otomatik bir görev oluşturur (konu → başlık, gövde → prompt).

---

## 13) Çoklu-model: Beyin + Akran (DeepSeek + MiMo birlikte) — Ayarlar (⚙️)

Ajanın "beynini" değiştirebilir, yanına bir **ikinci (akran) model** ekleyebilirsin. İki model eşittir;
hangisi beyin / hangisi akran sana bağlı. Tipik kurulum: **beyin = DeepSeek** (metin/akıl yürütme),
**akran = MiMo-VL** (görsel okur).

**Kurulum (admin):** Ayarlar → iki bölüm var:

1. **Model brain provider** — ajanın ana modeli.
   - `OpenAI-compatible` seç → **Base URL** (`https://api.deepseek.com` veya yerel `http://localhost:8000/v1`),
     **Model** (`deepseek-chat`), **API key**, istersen **fiyat** ($/1M) → Kaydet.
   - Varsayılan **Anthropic (Claude)**; dokunmazsan eskisi gibi çalışır.
2. **Peer model (second brain)** — beynin danışabileceği ikinci model (örn. `mimo-vl`). Aynı alanlar.

**Çalışma — iki yeni araç** (akran tanımlıysa otomatik açılır):

- **`consult_peer`** — beyin akrana tek bir soru sorar. **`image_path` verirse akran görseli okur** →
  metin-only DeepSeek böylece "görür" (MiMo görseli yorumlar, DeepSeek sonucu işler).
- **`critique_with_peer`** — beyin taslağını akrana **adversaryal eleştirttirir** (münazara): hatalar,
  zayıf varsayımlar, riskler + daha iyi öneri → beyin bunu nihai cevaba katar.

**Otomatik münazara (jüri) — Max efor + akran:** Bir görevi **Max** eforla çalıştırırsan **ve** akran
tanımlıysa, sistem cevabı otomatik **denetler**: beyin cevabını üretir → akran (örn. MiMo) onu
adversaryal eleştirir → beyin (jüri) bu eleştiriyi katarak **revize edilmiş nihai cevabı** verir. Çift
opt-in (akranı tanımla + Max seç); alt‑ajanlarda çalışmaz. Eleştiri + orijinal taslak görevin
sonucunda saklanır, revize cevap canlı görünüme yansır. (Beyin akranı her zaman `consult_peer` /
`critique_with_peer` araçlarıyla kendisi de çağırabilir; bu mod onu Max görevlerde garantiye alır.)
Münazara 2 ek çağrı yapar (akran eleştirisi + jüri); maliyeti görev maliyetine (`estCostUsd`) katılır.
Görevin bir maliyet bütçesi varsa ve bütçe çoktan dolmuşsa münazara **atlanır**.

**Gerçek çalıştırma için:** API `LLM_MODE=live` ile çalışmalı. Yerel bir MiMo/vLLM ucu kullanacaksan
API'yi **`ALLOW_LOCAL_BRAIN_URL=true`** ile başlat (yerel/LAN uçlar güvenlik gereği varsayılan kapalı).
Anahtarlar şifreli saklanır, HTTP'ye asla dönmez. Akran + jüri çağrılarının maliyeti faturalamaya işlenir.

---

## Hâlâ altyapı bekleyenler (henüz yok)

- **"My Computer"** (yerel klasör mount) + **kalıcı bulut VM** → yerel sidecar / VM altyapısı.
- **Domain satın alma / dağıtım**, **Skill marketi**, yerleşik veri kaynakları (Similarweb/World Bank).
- Daha fazla OAuth konnektörü (Gmail/Drive/Notion) — çerçeve hazır; her biri scope + client + araç ekleme.

İstediğin zaman ilgili anahtarı/kararı ver, o boşluğu da kapatalım.
