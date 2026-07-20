# WhatsApp Replay Studio

Ein lokales Browser-Tool, das exportierte WhatsApp-Chats aus einer ZIP- oder TXT-Datei als animiertes MP4 rendert.

[![Deploy GitHub Pages](https://github.com/ralphschuler/whatsapp-replay-studio/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/ralphschuler/whatsapp-replay-studio/actions/workflows/deploy-pages.yml)

**Online-Version:** [WhatsApp Replay Studio öffnen](https://nyphon.de/whatsapp-replay-studio/)

## Direkt verwenden

Die gebaute Datei `dist/index.html` ist vollständig eigenständig. Sie kann per Doppelklick in einem aktuellen Chrome-, Edge- oder Safari-Browser geöffnet werden. Der Chat und alle Medien bleiben im Browser und werden nicht hochgeladen.

1. In WhatsApp den gewünschten Chat öffnen.
2. **Chat exportieren** und optional **Medien einschließen** wählen.
3. Die ZIP in WhatsApp Replay Studio ziehen.
4. Die eigene Person, den Zeitraum, das Timing und das Videoformat auswählen.
5. Vorschau prüfen und **MP4 erstellen** anklicken.

## Unterstützt

- Android- und iOS-Exportformate
- Deutsche und englische Zeitstempel, 12-/24-Stunden-Format
- Mehrzeilige Nachrichten, Systemmeldungen und gleiche Zeitstempel
- Bilder, transparente Sticker, vollständige GIF-Zyklen und – bei Browser-Unterstützung – animierte WebP-Dateien mit ihrem ursprünglichen Seitenverhältnis
- Mehrere ausdrücklich in einem Chateintrag referenzierte Anhänge als zusammengehörige Medienfolge; keine unsichere Zuordnung anhand der ZIP-Reihenfolge
- Eigene Darstellung für Sprach- und Videonotizen; nicht-quadratische Videonotizen werden ohne Beschnitt in ihrem Originalformat gezeigt
- Vollständige Wiedergabe von Videos und Audioanhängen anhand ihrer echten Dateidauer, sofern der Browser den Codec dekodieren kann
- Eigenständige Audiodateien und dekodierbarer Videoton werden einschließlich Track-Zeitversatz in das MP4 gemischt
- Optionaler Eingangston für eingehende Nachrichten – auch im exportierten MP4
- Manuelle Korrektur für DMY-, MDY- und YMD-Datumsformate
- Adaptives Timing, fester Takt und Zeitraffer nach echten Zeitabständen
- 9:16, 1:1 und 16:9; 720p und 1080p
- H.264-MP4 über den lokalen Browser-Encoder
- Anonymisierung von Teilnehmernamen

## Entwicklung

```bash
npm install
npm run test
npm run build
```

Voraussetzung ist Node.js 20 oder neuer. Der Build bündelt alle Abhängigkeiten in eine einzelne `dist/index.html`.

## Nachrichtentypen

- **Text und Medien:** Text und Emoji, Bilder, transparente Sticker, GIFs und animierte WebP-Dateien, Videos, Videonotizen, Audiodateien und Sprachnachrichten. Dokumente dürfen eine beliebige oder gar keine Dateiendung haben. Mehrere explizit referenzierte Dateien eines Chateintrags werden als Album beziehungsweise Medienfolge abgespielt. VCF-/VCARD-Einzel- und Mehrfachkontakte einschließlich Quoted-Printable- und Base64-Namen sowie vorhandener Adressen, Websites, Geburtstage und Notizen werden als Kontaktkarte dargestellt. Medienbeschriftungen bleiben erhalten.
- **Strukturierte Karten:** Standorte und Live-Standorte, Kartenlinks, benannte Foursquare-Orte und „Dropped pin“, Sprach-, Video- und Gruppenanrufe, Weblinks, WhatsApp-Gruppen-, Community-, Kanal- und Anruflinks, Chat-Ereignisse samt Aktualisierung, Absage, Erinnerung und RSVP-Antworten, lokalisierte strukturierte Umfragen, Reaktionen sowie gesendete, empfangene, angeforderte, ausstehende, stornierte, abgelaufene, erstattete und fehlgeschlagene Zahlungen. Business-Inhalte umfassen Produkte, Produktanfragen und Einzel-/Mehrproduktlisten, Kataloge, Bestellungen, Warenkörbe, Anzeigen-/Referral-Kontext sowie hinreichend strukturierte Templates, Flows und Flow-Antworten, Standortanfragen, Adress-, CTA-, Code-, Karussell-, Button- und Listen-Nachrichten beziehungsweise deren explizite Antworten.
- **Systemereignisse:** Unter anderem Verschlüsselung und Sicherheitsnummern, Business-Kontohinweise, Erstellen und Umbenennen von Gruppen, Teilnehmer-, Untergruppen-, Admin- und Berechtigungsänderungen, Mitglieds-Tags, geteilter Gruppenverlauf, Einladungslinks, Ablauf-Timer, angeheftete Nachrichten, Gruppenbild und -beschreibung, Chat-Datenschutz, Telefonnummernwechsel, Communities, Ereignisse und Gruppenanrufe. Auch iOS-Exporte, die solche Einträge mit einem syntaktischen Sender schreiben, werden bei einem eindeutigen Service-Marker als Systemereignis normalisiert.
- **Besondere Zustände:** Gelöschte Nachrichten, ausgelassene Medien, Einmalansicht-Nachrichten, ausstehende beziehungsweise noch nicht entschlüsselte Nachrichten und von der WhatsApp-Version nicht unterstützte Inhalte erhalten eine eigene, klar erkennbare Darstellung.
- **Kontextkennzeichen:** „Weitergeleitet“, „Häufig weitergeleitet“ und „Bearbeitet“ werden nur bei einem entsprechenden Marker angezeigt. Explizite `>`-Textblöcke erscheinen als Zitat; eine nicht exportierte Reply-Beziehung wird daraus nicht abgeleitet.
- **Verlustfreier Fallback:** Ein unbekannter oder noch nicht spezialisierter Nachrichtentyp bleibt mit seinem vollständigen Originaltext erhalten. Teilnehmernachrichten erscheinen als normale Textnachricht, senderlose Ereignisse als generischer Systemchip, statt beim Import verworfen zu werden.
- **Lange Inhalte:** Hohe Medien werden proportional in die verfügbare Chatfläche eingepasst. Überlange Text-, Zitat- und Spezialkarten scrollen während ihrer verlängerten Standzeit vollständig von oben nach unten.
- **Grenzen des Exports:** Spezialkarten werden nur aus expliziten, hinreichend strukturierten Exportmarkern erzeugt. Fehlende Umfragestimmen oder Wähler, Reply- und Reaktionsbeziehungen, Bearbeitungshistorien, Lesebestätigungen, Zustellstatus, Sterne, verschwundene Inhalte und die ursprünglichen Daten gelöschter oder abgelaufener Einmalansicht-Nachrichten können nicht rekonstruiert werden. Das gilt ebenso für andere Informationen, die WhatsApp nicht in die TXT- oder ZIP-Datei schreibt.

## GitHub Pages

Der Workflow `.github/workflows/deploy-pages.yml` führt bei jedem Push auf `main` zuerst Tests und Build aus und veröffentlicht anschließend `dist/` über GitHub Pages. Er kann außerdem über **Actions → Deploy GitHub Pages → Run workflow** manuell gestartet werden.

Bei der ersten Einrichtung muss unter **Settings → Pages → Build and deployment → Source** einmalig **GitHub Actions** ausgewählt sein.

## Grenzen des MVP

Die tatsächlich dekodierbaren Bild-, Video- und Audioformate hängen von den Browser-Codecs ab. Das Tool kombiniert Dateiendung und – bei referenzierten Dateien innerhalb des Prüflimits – Container-Signatur; falsch oder ungewöhnlich benannte JPEG-, PNG-, GIF-, WebP-, MP4/QuickTime-, 3GP/3GPP-, Matroska/WebM-, Ogg/OGV-, WAV-, MP3-, AAC-, FLAC-, AMR-, CAF-, AIFF-, 3GA-, AVI- und MPEG-Dateien können dadurch passend eingestuft werden. Audio-only-Dateien mit einer Video-Endung werden nach Möglichkeit als Ton abgespielt. GIFs, die WhatsApp als MP4 exportiert, werden als Animation gekennzeichnet. Animierte GIF-/WebP-Dateien und WebP-Sticker werden über `ImageDecoder` für einen vollständigen Zyklus dargestellt. Überschreitet eine Animation die sichere Frame-, Pixel- oder Laufzeitgrenze oder fehlt der Browser-Decoder, erscheint ein statisches Bild statt einer abgeschnittenen Teilanimation. Ein reiner TXT-Export enthält keine Medienbytes und zeigt referenzierte Anhänge deshalb als fehlend. Medien werden nur bis zur 750-MB-Grenze des Eingabe-ZIPs verarbeitet. HEIC/HEIF-Bilder erscheinen in Browsern ohne passenden Decoder als Platzhalter. Live-/Motion-Photo-Bestandteile werden nur zusammengehalten, wenn der TXT-Export beide Dateien ausdrücklich referenziert; Dateinamen, Zeitnähe oder ZIP-Reihenfolge werden nicht als Zuordnungsbeweis verwendet. Die Anonymisierung ersetzt Senderlabels, aber keine Namen innerhalb von Nachrichtentexten oder Systemmeldungen. Sehr lange 1080p-Replays und die fertige MP4-Datei benötigen entsprechend viel Arbeitsspeicher; dafür empfiehlt sich zunächst der 720p-Export.
