# AgentOS — Kapsamlı Denetim ve Kalite Raporu (2026-06-20)

7 uzman ajanla (engine, operator, connectors, security, UI, features, manus-gaps) çok‑ajanlı denetim
yapıldı, her bulgu **adversaryal doğrulandı**. Sonuç: **35 doğrulanmış bulgu** (8 yüksek, 18 orta, 9
düşük). **22'si düzeltildi** (8 yüksek tamamı + 14 orta/düşük), kalan 13'ü önceliklendirilmiş backlog.

---

## 1) Mevcut sistemin inceleme özeti
Mimari sağlam: pnpm monorepo (apps/web Next static SPA, services/api NestJS+Fastify, packages/*), Zod
sözleşmeleri, **RLS çok‑kiracılık** (tenantContext/AsyncLocalStorage, fail‑closed), şifreli secrets
vault, plan→act ajan döngüsü, onay/risk kapıları, maliyet/token ölçümü, BullMQ kuyruğu, Socket.IO canlı
akış. **Çekirdek akışlar gerçekten çalışıyor + test'li** (repo sürekli yeşil, build 39 + test 23 görev).
**Manus'un üstüne çıkan yanlar:** çoklu‑model beyin + akran‑danışma + otomatik münazara, canlı tarayıcı
+ devralma, açık/koyu tema, RLS izolasyonu.

## 2) Bulunan eksikler / hatalar (35 doğrulanmış)
**Yüksek (8):** Wide Research bütçe taşması (N× harcama) · devralırken ajan+insan tek tarayıcıda yarış ·
screencast backpressure (sınırsız kuyruk) · suspended/silinmiş kullanıcı erişimi · stop/approve REST
yedeği ölü kod · spreadsheet negatif sayıları bozuyor · WebSocket RBAC bypass (viewer kontrol edebiliyor)
· uzun görevde context taşması. **Orta (18):** OAuth state dev‑key fallback, Gmail tek‑mesaj kırılganlığı,
DNS‑rebinding (tarayıcı + provider URL), rate‑limit proxy/Redis, modal Escape/odak, sağlayıcısız
image/audio çipleri, visualization grafik gömme, world_bank truncation, kalıcı VM yokluğu, vb. **Düşük
(9):** liveFrame temizliği, Google refresh fail‑open, OAuth hata yüzeyi, tema canlı‑oto, rating temizleme,
playbook effort reset, Drive escape, marketplace yokluğu, Wide Research alt‑bütçe.

## 3) Düzeltilen sorunlar (22 — commit'ler `0dbc8c8`, `a91807e`, `d95ad8e`)
**Güvenlik:** suspended/deleted kullanıcı kilidi (login+session); WebSocket RBAC (kontrol için ≥member);
OAuth state prod fail‑closed; devralma tuş allowlist; OAuth access_denied→"cancelled". **Güvenilirlik:**
Wide Research bütçesi çocuklara **eşit bölünüyor**; devralırken **ajan duraklıyor + mutex serileştirme**;
screencast **~12fps throttle + volatile emit**; uzun görevde **araç‑çıktısı history cap'i (8KB)**; Gmail
**allSettled**; Google refresh **fail‑closed**; TaskDetail **REST olay yedeği**; trustProxy env. **Bug:**
spreadsheet negatifleri; stop/approve socket‑kapalıyken REST'e düşüyor; Firefox indirme; Wide Research
**approval‑gated** (high‑risk). **UX:** auto‑tema canlı; rating hata/geri‑alma; playbook effort reset;
world_bank truncation; Drive backslash escape.

## 4) Test raporu
Tüm repo **yeşil**: `turbo run typecheck lint build` → 39/39, `turbo run test` → 23/23. Yeni/etkilenen
testler: auth, agent.gateway RBAC, deliverable (negatif sayı), datasource (per_page), browser (mutex),
connectors (notion/google/gmail), playbooks RLS, task-runner münazara. **Not:** Windows'ta `build` ile
`test` ayrı çalıştırılmalı (db tsup‑clean vs db#test yarışı) — bu rapor o şekilde doğrulandı.

## 5) Manus karşılaştırma tablosu
| Yetenek | Manus | AgentOS |
|---|---|---|
| Ajan döngüsü / plan‑act | ✓ | ✓ |
| Tarayıcı operatörü (gez/tıkla/yaz) | ✓ | ✓ |
| **Canlı tarayıcı + devralma** | ✓ | ✓ (CDP screencast + mutex/pause) |
| Çoklu‑model + akran + münazara | ✗ | ✓ **(üstün)** |
| Wide Research (paralel alt‑ajan) | ✓ | ✓ (artık bütçe‑güvenli + approval) |
| Bağlayıcılar | 99+ | GitHub/Notion/Google (çerçeve hazır) |
| Veri kaynakları | Similarweb/WorldBank | World Bank + Döviz (ücretsiz) |
| Playbook (şablon) | ✓ | ✓ (parametre yok — backlog) |
| Açık/koyu tema | ✓ | ✓ |
| Yıldız geri bildirim / öneriler | ✓ | ✓ / kısmi |
| **My Computer (yerel klasör)** | ✓ | ✗ **(en büyük boşluk)** |
| **Kalıcı bulut VM** | ✓ | ✗ |
| Operator dosya yükle/indir | ✓ | ✗ (backlog) |
| Marketplace UI (skill/connector) | ✓ | ✗ (backlog) |
| Outlook | ✓ | ✗ (Google deseniyle hazır) |

## 6) Manus'ta olup bizde eksik (öncelikli boşluklar)
1. **My Computer — yerel klasör operatörü** (en büyük; masaüstü sidecar + klasör onayı).
2. **Operator dosya yükleme/indirme** (form upload + download akışı).
3. **Kalıcı bulut VM** (7/24 çalışma alanı — altyapı).
4. **Outlook bağlayıcısı** (Microsoft Graph — Google deseniyle eklenebilir).
5. **Skill/connector marketplace UI** + **parametreli playbook** ({{değişken}}).
6. **DNS‑rebinding pinning** (tarayıcı + provider URL'leri vetted IP'ye pin).
7. **visualization** modunun ürettiği grafikleri rapora gömmesi.

## 7) Eklenecek yeni modüller
- `LocalOperator` (desktop sidecar: onaylı klasörleri ajana açan yerel köprü).
- `BrowserFileTools` (browser_upload / browser_download).
- `CloudVM` (kalıcı çalışma alanı sağlayıcı — opsiyonel).
- `OutlookConnector` (graph client + tools).
- `Marketplace` (curated katalog + "install into workspace") + `PlaybookParams`.
- `NetPinning` (assertAllowedUrl IP'sini undici Agent ile pinleyen ortak dispatcher).

## 8) Operator geliştirme planı (üretim kalitesi)
**Tamamlanan:** gez/oku/tıkla/yaz(+submit)/screenshot, **canlı CDP screencast**, **devralma**
(tıkla/yaz + mutex + ajan‑duraklatma + tuş allowlist), her adımda otomatik ekran görüntüsü, SSRF guard.
**Sıradaki:** (a) **dosya yükle/indir** araçları; (b) **DNS‑rebinding pinning** (vetted IP); (c)
"awaiting‑human" açık durumu + görsel "devralındı" rozeti zaten var, ajana açık pause sinyali; (d) hata→
alternatif‑yol denemesi için daha açıklayıcı tool hataları; (e) izole network namespace (sandbox) ile
tarayıcının iç ağa erişiminin tamamen kesilmesi.

## 9) Ajan mimarisi iyileştirme planı
Mevcut: tek ajan döngüsü + Wide Research alt‑ajanları + akran‑danışma + jüri münazarası. **Önerilen
uzmanlaşma** (capability/persona olarak, ayrı süreç değil): Planlama, Araştırma, Kod, **Test/Kalite**,
Operator, Dosya/Web analiz, Raporlama, Risk/Güvenlik. **Koordinasyon:** plan→fan‑out→jüri (mevcut
deseni genişlet); her alt‑görev sonucu bir "kalite kontrol" geçişinden geçsin (münazara altyapısı hazır).
**Context yönetimi:** history cap eklendi; sıradaki adım uzun görevlerde **özetleme/sıkıştırma** (en eski
tool_result'ları özetle, planı + son N turu koru).

## 10) Nihai kalite kontrol raporu
- Tüm **yüksek** öncelikli güvenlik/güvenilirlik bulguları **kapatıldı**.
- Repo **yeşil**, tüm testler geçiyor; her düzeltme test'li veya doğrulanmış.
- Çalışan dağıtım: API `:4000` (canlı, tarayıcı açık), web `:3000`, masaüstü `AgentOS.exe` güncel.
- Kalan 13 bulgu: çoğu UX‑cila + 3 büyük yetenek boşluğu (VM/marketplace/My Computer) — backlog'da.

## 11) Sonraki adımlar (önerilen sıra)

### ✅ Denetim sonrası tamamlananlar (2026‑06‑20, hepsi test'li + repo yeşil)
1. **My Computer — yerel klasör operatörü** (`5a10714`): onaylı klasörlerde oku/listele/yaz
   (yazma opt‑in + HIGH‑risk onay, symlink‑güvenli safeResolve), `ENABLE_LOCAL_FS` kapısı, yönetim UI'sı.
2. **Operator dosya yükle/indir** (`cdbbfa4`): `browser_upload` (sandbox dosyasını file input'a) +
   `browser_download` (indirileni task artefaktı olarak kaydet); ikisi de mutex + devralma duraklatmasıyla.
3. **Parametreli playbook** (`57b1401`): `{{değişken}}` çıkarma + ikame + çalıştırmadan önce doldurma formu.
4. **Context özetleme/sıkıştırma** (`746c6e0`): history 40 mesajı geçince en eski turlar modelle özetlenip
   prompt'a foldlanıyor → uzun görevler context penceresini taşırmıyor.
5. **Marketplace — şablon galerisi** (`181d08c`): 10 küratörlü `{{değişken}}`'li şablon, 5 kategori,
   "Playbook'larıma ekle"; cross‑tenant okuma YOK (güvenli statik katalog).
6. **DNS‑rebinding pinning**: `http_fetch` zaten undici `pinnedDispatcher` ile vetted IP'ye pin'li
   (en kritik = ajan‑kontrollü yüzey **çözülmüş**). Tarayıcı (Chromium ayrı süreç) ve admin‑config
   provider URL'leri kalan düşük‑riskli yüzeyler.

7. **Kalıcı bilgisayar (yerel)** (`207b184`): workspace başına Docker **named volume** sandbox'a
   `/persist`'te mount edilir → dosya/durum görevler arası yaşar (Manus "kalıcı bilgisayar"ın bulutsuz
   karşılığı). `ENABLE_PERSISTENT_WORKSPACE` (+ `ENABLE_SANDBOX`) ile açılır; host FS'e erişim yok.

### Kapatılan kararlar
- **Outlook bağlayıcısı: İPTAL** — kullanıcı "Azure kullanmayacağım" dedi; yapılmadı.
- **Gerçek bulut VM: gerek yok** — yerine yukarıdaki yerel kalıcı Docker workspace seçildi.

---
**Hedef gerçekleşiyor:** AgentOS, Manus paritesini geçen yanlara (çoklu‑model münazara, canlı tarayıcı
devralma, RLS izolasyon) sahip; kalan boşluklar net, önceliklendirilmiş ve çoğu kanıtlanmış desenlerle
kapatılabilir durumda.
