# KDM Planner kullanım kılavuzu

Bu kılavuz eklentinin tüm özelliklerini anlatır. Kısa özet için [README](../README.md), KDM sunucusunun nasıl çalıştığı
için `src/kdm-protocol.ts` ve `src/kdm-client.ts` dosyalarına bakın.

## İçindekiler

1. [Kurulum ve giriş](#1-kurulum-ve-giriş)
2. [Haftalık plan bloğu](#2-haftalık-plan-bloğu)
3. [KDM'ye aktarma](#3-kdmye-aktarma)
4. [KDM takvimi](#4-kdm-takvimi)
5. [Görev ekleme ve düzenleme penceresi](#5-görev-ekleme-ve-düzenleme-penceresi)
6. [İzin günü](#6-izin-günü)
7. [Kurallar ve uyarılar](#7-kurallar-ve-uyarılar)
8. [KDM ile eşitleme](#8-kdm-ile-eşitleme)
9. [Komutlar ve ayarlar](#9-komutlar-ve-ayarlar)
10. [Gizlilik ve güvenlik](#10-gizlilik-ve-güvenlik)
11. [Sorun giderme](#11-sorun-giderme)

---

## 1. Kurulum ve giriş

1. Eklentiyi kurup **Ayarlar → Topluluk eklentileri** bölümünden açın.
2. **Ayarlar → KDM Planner** sayfasında **E-posta** alanına KDM hesabınızı yazın. **KDM URL** alanına KDM sitesinin adresini yazın
   (ör. `https://kdm.example.com`); varsayılan adres yoktur.
3. **Giriş yap** düğmesine basın ve parolanızı yazın.

Giriş sonrası:

- Erişim anahtarı ve yenileme anahtarı Obsidian'ın **gizli depolamasında** saklanır. **Parola hiçbir yerde saklanmaz.**
- KDM URL'si **HTTPS** olmalıdır (yalnızca `localhost` için düz HTTP kabul edilir). URL'yi değiştirirseniz kayıtlı oturum silinir ve yeniden giriş istenir; anahtarlar hiçbir zaman başka bir adrese gönderilmez. **Çıkış yap** yenileme anahtarını KDM'de de iptal ettirmeye çalışır.
- KDM'ye giden her istek 30 saniye içinde yanıt almazsa zaman aşımına uğrar ve düğmeler yeniden etkinleşir.
- Anahtar süresi dolmadan otomatik yenilenir. Yenileme de başarısız olursa giriş yeniden istenir.
- **Görev listeniz** (planlayabileceğiniz görevler) girişte bir kez çekilir ve önbelleğe alınır. Listeyi sonradan
  yenilemek için *Görev listesini yenile* komutunu ya da ayarlardaki **Görevleri yenile** düğmesini kullanın.
- *KDM bağlantısını sına* komutu bu haftanın kayıtlarını okuyarak bağlantının çalıştığını gösterir.

## 2. Haftalık plan bloğu

Bir notun içine koyduğunuz, bir haftalık notlarınızı günlere göre tutan bloktur.

**Eklemek için:**

- Herhangi bir notun sağ üst başlık çubuğundaki **takvim simgesine** ("KDM haftalık planı ekle") basın, ya da
- komut paletinden (Cmd/Ctrl+P) **Haftalık plan bloğu ekle** komutunu çalıştırın.

Hafta sorulur: **Geçen hafta / Bu hafta / Gelecek hafta** düğmeleri ya da haftanın herhangi bir günü. Seçili düğme
vurgulu ve ✓ işaretlidir. Aynı nota istediğiniz kadar farklı haftanın bloğunu ekleyebilirsiniz. Düzenleme modunda blok
imlecin olduğu yere, okuma modunda notun sonuna eklenir.

**Biçim.** Blok düz metindir, kaynak modunda da düzenlenebilir:

````
```kdm-week
hafta: 2026-10-26
## Pzt 26.10
### Öğleden önce
- 09:00-10:30 Müşteri toplantısı
- Rapor hazırla
### Öğleden sonra
- Sözleşme taslağı {kdm:123456}
## Sal 27.10
### Öğleden önce
### Öğleden sonra
```
````

- `hafta:` satırı haftayı belirler (haftanın herhangi bir günü yazılabilir; Pazartesi'ye çevrilir).
- Her gün iki bölüme ayrılır: **Öğleden önce** ve **Öğleden sonra** (aralarında öğle arası vardır).
- Bir not `- ` ile başlar. İsteğe bağlı olarak başında `09:00-10:30` gibi bir saat aralığı yazılabilir.
- Sonunda `{kdm:123456}` varsa not KDM'ye aktarılmıştır; sayı KDM kayıt numarasıdır. `{kdm:?}` kayıt numarası okunamayan
  aktarılmış nottur.
- Blok her değişiklikte düzenli biçimde yeniden yazılır. Gün başlıklarının dışındaki serbest satırlar korunmaz.

**Okuma modunda** blok bir haftalık ızgara olarak görünür: her gün kendi kartıdır, bugün vurgulanır. Gün başlığında
o gün KDM'ye girilen toplam süre yazar. Her günün altındaki iki bölümde:

- bölümün üstünde, o gün için **KDM'de zaten bulunan kayıtlar** renkli kutucuklar olarak görünür (saat, görev adı). Bir
  nottan aktarılmış kayıtlar kutucuk olarak tekrarlanmaz, not satırı olarak görünür;
- altında notlarınız ve **Not ekle...** kutusu vardır. Yazıp Enter'a basarak not eklersiniz. Saatli bir not (`14:00-15:00 …`)
  hangi kutuya yazılmış olursa olsun saatinin düştüğü bölüme gider.

**Not satırındaki düğmeler:**

| Düğme | Aktarılmamış not | KDM'ye aktarılmış not |
| --- | --- | --- |
| **KDM'ye aktar** | Görev ekleme penceresini açar | (yerine **✓ KDM** etiketi görünür) |
| ✎ (mavi) | Yalnızca nottaki metni düzenler | KDM'nin düzenleme penceresini açar; kaydedince not da güncellenir |
| ✓ (yeşil) | yok | Kaydı **Tamamlandı** yapar (yalnızca *Planlandı* durumunda) |
| × (kırmızı) | Notu siler (KDM'ye dokunmaz) | KDM kaydını **ve** notu siler |

Aktarılmış not satırı, KDM takvimindeki gibi durum rengini alır: **sarı** Planlandı, **yeşil** Tamamlandı, **kırmızı**
Tamamlanmadı, **gri** İzin günü. Durumun adı yazılmaz; üzerine gelince ipucu olarak görünür. Notun metnine çift
tıklamak da yerel metin düzenlemeyi açar.

**Blok çubuğundaki düğmeler:**

| Düğme | Ne yapar |
| --- | --- |
| **Yenile** | Haftayı KDM'den çeker ([§8](#8-kdm-ile-eşitleme)) |
| **Takvimi aç** | KDM takvimini açar |
| **Bloğu kaldır** | Bu haftalık bloğu nottan siler. **KDM'ye dokunmaz.** Notlar silineceği için onay ister |

> Düzenleme modunun sağ üstündeki "bu bloğu düzenle" simgesi Obsidian'ındır; çubuk onunla çakışmayacak şekilde
> boşluk bırakır.

## 3. KDM'ye aktarma

Bir notun yanındaki **KDM'ye aktar** düğmesi görev ekleme penceresini **önceden doldurulmuş** olarak açar:

- **Açıklama:** notun metni.
- **Görev:** görev listenizden, nottaki kelimelerle en çok örtüşen görev seçilir (Türkçe ek farkları tolere edilir:
  "toplantısı" ↔ "toplantı"). Eşleşme yoksa listenin ilk görevi; her zaman değiştirebilirsiniz.
- **Saat:** notta saat yazıyorsa o saat. Yoksa, notun yazıldığı yarım günde (öğleden önce/sonra) **ilk boş aralık**
  önerilir: varsayılan süre kadar, mevcut kayıtlardan sonra mola payı bırakılarak, **öğle arasına denk gelmeden**. O
  yarımda yer yoksa günün başka yerine bakılır.
- **Durum:** geçmiş günler için *Tamamlandı*, bugün ve sonrası için *Planlandı*. "izin" ile başlayan notlar *İzin günü*
  olur ([§6](#6-izin-günü)).

Ekle'ye basınca kayıt KDM'ye yazılır. Sonra not şu şekilde güncellenir:

- Nota `{kdm:numara}` işareti yazılır; satır "✓ KDM" etiketi ve durum rengini alır.
- Not, **seçtiğiniz saatin** düştüğü yarım güne taşınır. Öğleden önce yazdığınız bir notu öğleden sonraki saate
  aktardıysanız öğleden sonra bölümüne, saat sırasına göre yerleşir; öğleden önce bölümünde kalmaz. Notun satırına seçilen
  saat aralığı da yazılır.
- Tüm gün izinde not yerinde kalır.

## 4. KDM takvimi

**Açmak için:** sol şeritteki takvim simgesi ya da *KDM takvimini aç* komutu. KDM'nin planlama sayfasındaki haftalık takvimin
karşılığıdır.

- **Görünüm:** Pazartesi-Pazar (ayarlardan hafta sonu gizlenebilir), mesai saatleri (varsayılan 08:30-17:30; mesai dışı kayıt varsa ızgara genişler), 30 dakikalık hücreler, bugün
  vurgulu ve güncel saat çizgisi. **Öğle arası** çizgili bir bantla işaretlidir ve günü ikiye böler.
- **Gezinme:** ‹ önceki hafta, **Bugün**, › sonraki hafta. **Yenile** haftayı KDM'den taze çeker.
- **Yeni görev:** boş bir hücreye tıklayın (30 dakikalık kayıt önerilir) ya da **Yeni görev** düğmesine basın.
- **Düzenleme:** bir kayda tıklayın.
- **Taşıma:** *Planlandı* durumundaki bir kaydı sürükleyin (30 dakikalık adımlarla, günler arası da). Kural ihlali varsa
  kayıt yerine döner ve nedeni bildirilir.
- **Uzatma/kısaltma:** kaydın alt kenarından sürükleyin.
- **Sağ tık menüsü:** Düzenle (kilitliyse *Görüntüle*), Tamamla, Sil.
- **Hızlı düğmeler:** kaydın sağ altında her zaman görünen yeşil **✓** (Tamamlandı yap) ve kırmızı **×** (sil, onay ister).
- **Renkler:** sarı Planlandı, yeşil Tamamlandı, kırmızı Tamamlanmadı, gri İzin günü. Çakışan kayıtlar yan yana dizilir.
  Çok günlü izinler her güne parça olarak yansır.

**Kilitli kayıtlar.** KDM, geçmiş haftalardaki kayıtların değişmesine izin vermez; eklenti de vermez. Şirket numarası 43 olan hesaplarda
düzenleme sınırı **bugünden 7 gün öncesi**, diğer hesaplarda **içinde bulunulan haftanın Pazartesi'sidir**. Kilitli
kayıtlar soluk görünür, düğmeleri yoktur ve tıklayınca **salt okunur görüntüleme penceresi** açılır: görev, küme, durum,
tarih, saat, süre, açıklamanın tamamı ve kayıt numarası.

## 5. Görev ekleme ve düzenleme penceresi

Hem takvimden hem nottan açılan aynı penceredir.

| Alan | Açıklama |
| --- | --- |
| Durum | Planlandı, Tamamlandı, Tamamlanmadı, İzin günü |
| Görev | Görev listenizden seçilir; kutuya yazarak aranır. İzin gününde gizlidir |
| Tarih | Kaydın günü |
| Saat | Başlangıç ve bitiş. Altındaki süre düğmeleri (30 dk, 1 sa, 1,5 sa, 2 sa, 3 sa, 3,5 sa) bitişi başlangıca göre ayarlar; süre yazılı görünür |
| Açıklama | Serbest metin |

- Pencere **canlı doğrulama** yapar: kırmızı mesajlar kaydı engeller (Ekle/Kaydet pasif olur), turuncu mesajlar yalnızca
  uyarır ([§7](#7-kurallar-ve-uyarılar)).
- Düzenleme modunda ayrıca **Tamamla** (yalnızca *Planlandı* kayıtta) ve **Sil** düğmeleri vardır. Ctrl/Cmd+Enter
  açıklama alanından kaydeder.
- KDM'ye istek giderken pencerenin tüm düğmeleri pasif olur. Hata olursa uyarı çıkar, düğmeler yeniden etkinleşir ve
  pencere açık kalır; başarıda pencere kapanır ve görünümler yenilenir.

## 6. İzin günü

Durum olarak **İzin günü** seçilince görev alanı kalkar ve **İzin türü** sorulur:

- **Tüm gün (08:30 - 17:30):** *Bitiş tarihi* ile birden çok güne yayılabilir. Süre, çalışılan gün başına 8 saat sayılır
  (Pazartesi-Cuma 5 gün = 40 saat); hafta sonu günleri saate eklenmez.
- **Saatlik:** başlangıç/bitiş saati girilir; süre saat olarak kaydedilir. Blok sınırı, öğle arası ve mola kuralları
  izne uygulanmaz; kilitli gün kuralı uygulanır.

Notlarda **"izin"** (ör. "izin", "yıllık izin", "izinli") ile başlayan satırlar aktarılırken otomatik *İzin günü* olur;
notta saat aralığı da yazılıysa **saatlik izin** olarak açılır.

İzinle çakışan görev girilemez (hata). Aynı tarihlere ikinci bir izin girmek yalnızca uyarı verir.

## 7. Kurallar ve uyarılar

**KDM'nin kurallarından alınanlar (hata, kayıt engellenir):**

- Başlangıç ve bitiş **aynı gün** olmalı (izin hariç) ve bitiş başlangıçtan sonra olmalı.
- Kilitli (geçmiş) günlere yazılamaz.
- İzin gününe denk gelen görev girilemez.
- Taşıma/uzatma yalnızca *Planlandı* kayıtlarda yapılır.

**Sizin kurallarınız:**

- **4 saat ve üstü bloklar girilmez** (hata). Sınır ayarlardan değiştirilir.
- **Görevler arası mola** (varsayılan 15 dk) — eksikse *uyarı*.
- **Çakışma** — başka bir görevle çakışırsa *uyarı* (engellemez).
- **Öğle arasına denk gelen** görev — *uyarı*. Önerilen saatler öğle arasına yerleştirilmez.
- **"Diğer görev" türü hiç oluşturulmaz.** Her kayıt, görev listenizdeki bir göreve (ya da izne) bağlıdır.

## 8. KDM ile eşitleme

Eklenti, notlarınızla KDM'yi birbirinden bağımsız ama tutarlı tutar:

- **Mevcut kayıtlar üstte:** KDM'de zaten olan kayıtlar planlayıcıda kutucuk olarak görünür; böylece aktarmadan önce hangi
  saatlerin dolu olduğunu görürsünüz.
- **Yenile** (planlayıcı çubuğunda): haftayı KDM'den çeker; **aktarılmış** notlar KDM'deki duruma uyar — saat, öğleden
  önce/sonra bölümü ve gün (KDM'de başka güne taşıdıysanız not da taşınır), renk (durum). **Aktarılmamış notlara hiç
  dokunulmaz.** `{kdm:?}` işaretli notların numarası, açıklaması eşleşen kayıttan tamamlanır. KDM takvimi de aynı anda
  yenilenir.
- **KDM'de silinen kayıt:** Aktarılmış bir notun kaydı KDM'den silindiyse (örneğin KDM takviminden), blok açılırken ya da
  *Yenile*'de kayıt numarasıyla KDM'ye sorulur; gerçekten yoksa not **aktarılmamış** hale döner (işaret kalkar, saat ve
  metin kalır) ve yeniden aktarabilirsiniz. Başka haftaya taşınmış kayıtlara ve emin olunamayan durumlara (oturum,
  sunucu hatası) dokunulmaz.
- **Düzenleme sonrası:** KDM penceresinden kaydettiğinizde notun metni (açıklama), saati, bölümü ve günü KDM'e göre güncellenir.
  Penceredeki **Sil** kaydı KDM'den siler, not ise aktarılmamış nota döner.

**İşlem sırasında düğmeler:** KDM'ye istek atan her düğme (aktar, ✓, ×, ✎, Yenile, penceredeki düğmeler) istek sürerken
**pasif** olur ve soluk görünür. Başarıda görünüm KDM'den yenilenir; hatada düğme hemen yeniden etkinleşir ve uyarı çıkar.
Silme gibi onay isteyen işlemlerde düğme, onaydan sonra, istek gerçekten gönderilirken pasifleşir.

**Silme hataları:** KDM silmeyi reddederse (ör. kilitli kayıt, bağlantı/oturum hatası) "KDM'den silinemedi: …" uyarısı
çıkar ve **not silinmez**.

## 9. Komutlar ve ayarlar

**Komutlar** (Cmd/Ctrl+P):

| Komut | Açıklama |
| --- | --- |
| KDM takvimini aç | Haftalık takvimi açar |
| KDM'ye görev ekle | Bugün için görev ekleme penceresini açar |
| Haftalık plan bloğu ekle | Seçeceğiniz hafta için plan bloğu ekler (düzenleyicide) |
| Görev listesini yenile | Görev listesini KDM'den yeniden çeker |
| KDM'ye giriş yap | Parola sorar ve giriş yapar |
| KDM'den çıkış yap | Anahtarları ve önbelleği siler |
| KDM bağlantısını sına | Bu haftanın kayıtlarını okur |

Ayrıca sol şeritte **takvim simgesi**, notların başlık çubuğunda **KDM haftalık planı ekle** simgesi vardır.

**Ayarlar:**

| Ayar | Varsayılan | Açıklama |
| --- | --- | --- |
| KDM URL | boş | KDM sitesinin adresi (ör. `https://kdm.example.com`). HTTPS kullanın |
| E-posta | boş | Giriş hesabı |
| Oturum | — | Giriş yap / Yeniden giriş, Görevleri yenile, Çıkış |
| Öğle arası başlangıcı / bitişi | 12:30 / 13:30 | Günü öğleden önce/sonra diye böler; takvimde bant, planlayıcıda ayraç, saat önerilerinde boşluk. Bitiş başlangıçtan sonra olmalı |
| Görevler arası mola (dk) | 15 | Eksikse uyarı |
| Blok sınırı (saat) | 4 | Bu süre ve üstü bloklar girilmez |
| Varsayılan görev süresi (dk) | 60 | Saat önerisi için |
| Mesai başlangıcı / bitişi | 08:30 / 17:30 | Takvimin saat aralığı ve yeni görevin önerilen saati. Mesai dışına taşan kayıt girilebilir, yalnızca uyarı verir. Bitiş başlangıçtan sonra olmalı |
| Hafta sonunu göster | açık | Takvimde ve haftalık plan bloğunda Cumartesi/Pazar |

## 10. Gizlilik ve güvenlik

- Eklenti yalnızca ayarlardaki **KDM URL'sine** bağlanır (giriş, anahtar yenileme, kayıtları ve görev listesini okuma,
  istediğinizde kayıt ekleme/değiştirme/silme). Başka sunucuya istek atılmaz; telemetri/reklam yoktur.
- **Parola saklanmaz**; yalnızca girişte KDM'ye gönderilir.
- Erişim ve yenileme anahtarları **Obsidian'ın gizli depolamasındadır**, `data.json`'da değildir.
- `data.json`'da ayarlarınız, e-postanız, KDM'nin döndürdüğü adınız/soyadınız/kullanıcı numaranız/şirket numaranız ve görev
  listenizin önbelleği bulunur. Giriş yanıtındaki diğer profil alanları (kimlik numarası gibi) **diske yazılmaz**.
- Eklenti notlarınızdan yalnızca `kdm-week` bloğu içeren notlara ve yalnızca o bloğa yazar.
- Eklenti KDM'nin web sayfasının kullandığı uçlarla çalışır (resmi bir API belgesi yoktur); işlemler **sizin yetkilerinizle,
  kendi kayıtlarınız üzerinde** yapılır. KDM tarafı değişirse eklenti etkilenebilir.

## 11. Sorun giderme

| Belirti | Çözüm |
| --- | --- |
| Komutlar/simge görünmüyor | Eklentiyi Ayarlar → Topluluk eklentileri'nden kapatıp açın ya da Obsidian'ı yeniden başlatın |
| Plan bloğu düz metin görünüyor | Notu **okuma moduna** alın (Cmd/Ctrl+E) |
| "Giriş yapın" | Ayarlardan e-postayı girip **Giriş yap**'a basın |
| "Oturum süresi doldu" | Yeniden giriş yapın (yenileme anahtarı da geçersiz) |
| Aktarılmış not renksiz / "✓ KDM" ama kayıt yok | Planlayıcıda **Yenile**'ye basın |
| "Bu blok burada düzenlenemiyor" | Blok gömülü/başka bir görünümde; notu açıp orada düzenleyin |
| "Not değişmiş. Blok bulunamadı…" | Not siz düzenlerken değişti; bloğu yeniden açıp tekrar deneyin |
| "… öncesindeki günler kilitli" | KDM geçmiş haftaları kilitler; kayıt görüntülenebilir ama değiştirilemez |
| Görev listesi boş/eski | *Görev listesini yenile* komutunu çalıştırın |
