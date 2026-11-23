Bu projenin ana iş akışlarını ve algoritmalarını akış şeması olarak çiz (Kokpit › Akış paneli bunları gösterir).

1. Önce kodu oku: giriş noktaları, ana kullanıcı/veri akışları, önemli algoritmalar, durum makineleri, hata ve
   yeniden deneme yolları. Tahmin etme; yalnız kodda gerçekten olanı çiz. Gerekirse README ve docs/ klasörüne bak.
2. En önemli 3–8 akışı seç. Her akış için `docs/akis/` klasörüne **ayrı bir Mermaid dosyası** yaz:
   `docs/akis/<kisa-ad>.mmd` (küçük harf, tire ile; ör. `giris-akisi.mmd`). Klasör yoksa oluştur.
3. Her dosyanın **ilk satırı** Türkçe başlık yorumu olsun, ardından şema:

   ```
   %% title: Kullanıcı girişi
   flowchart TD
     A([Başla]) --> B[Formu oku]
     B --> C{Şifre doğru mu?}
     C -- Evet --> D[Oturum aç]
     C -- Hayır --> E[Hata göster]
   ```

4. Kurallar:
   - Yalnız `flowchart` (TD ya da LR) kullan; kararlar için **karar düğümü** `{...}` ve etiketli dallar (`-- Evet -->`).
   - Düğüm metinleri kısa ve Türkçe; kod adları (fonksiyon, dosya) gerektiğinde parantez içinde.
   - `click`, `href`, `call`, HTML etiketi, betik ya da dış bağlantı **kullanma** (Kokpit bunları zaten engeller).
   - Bir şema ~40 düğümü geçmesin; büyük akışı alt akışlara böl (ayrı dosyalar).
   - Dosyalar zaten varsa kodla karşılaştır ve **güncelle**; artık olmayan akışların dosyasını sil.
5. Bitince oluşturduğun/güncellediğin dosyaları ve her birinin neyi anlattığını bir cümleyle listele.
