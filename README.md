# WhatsApp Replay Studio

Ein lokales Browser-Tool, das exportierte WhatsApp-Chats aus einer ZIP- oder TXT-Datei als animiertes MP4 rendert.

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
- Bilder und Sticker sowie eine bis zu vier Sekunden lange, stumme Vorschau für Videos
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

## Grenzen des MVP

Videos werden ohne Originalton für bis zu vier Sekunden angespielt. Sprachnachrichten werden weiterhin als Medienkarten dargestellt. HEIC-Bilder können je nach Browser nur als Platzhalter erscheinen. Sehr lange 1080p-Replays benötigen entsprechend viel Arbeitsspeicher; dafür empfiehlt sich zunächst der 720p-Export.
