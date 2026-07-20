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
- Bilder, Sticker und animierte GIFs mit ihrem ursprünglichen Seitenverhältnis
- Bis zu vier Sekunden Wiedergabe für Videos und Audioanhänge; Audio wird in das MP4 gemischt
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

## GitHub Pages

Der Workflow `.github/workflows/deploy-pages.yml` führt bei jedem Push auf `main` zuerst Tests und Build aus und veröffentlicht anschließend `dist/` über GitHub Pages. Er kann außerdem über **Actions → Deploy GitHub Pages → Run workflow** manuell gestartet werden.

Bei der ersten Einrichtung muss unter **Settings → Pages → Build and deployment → Source** einmalig **GitHub Actions** ausgewählt sein.

## Grenzen des MVP

Videos werden ohne ihre eingebettete Originaltonspur für bis zu vier Sekunden angespielt; eigenständige Audioanhänge werden dagegen hörbar wiedergegeben. Animierte GIFs benötigen für eine framegenaue Wiedergabe einen Browser mit `ImageDecoder` und erscheinen andernfalls als statisches Bild. HEIC-Bilder können je nach Browser nur als Platzhalter erscheinen. Sehr lange 1080p-Replays benötigen entsprechend viel Arbeitsspeicher; dafür empfiehlt sich zunächst der 720p-Export.
