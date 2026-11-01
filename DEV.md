# Entwicklung (Fork Cloud)

## Lokal (Windows)

- Repo: `C:\Users\oppel\iobroker-dev\ioBroker.bambulab`
- **Prod-ioBroker:** MCP `iobroker-prod` (10.1.1.10)
- **Test-ioBroker:** MCP `iobroker-1` (10.1.1.111, Docker `a466d9d06dba`)

## Auf Test-Container deployen (Unraid Docker)

Vom **GitHub-Fork** installieren, **im ioBroker-Container**:

```bash
iobroker url https://github.com/crunchip77/ioBroker.bambulab/tarball/feature/cloud-mqtt
```

Danach Instanz **bambulab.0** neu starten (bei Cloud-Updates **kein** Token leeren, wenn Login schon ok war).

## Cloud-Login (Stand Fork)

1. `connectionMode = cloud`, Modell + **Serial** setzen
2. E-Mail, ggf. leeres Token-Feld
3. Instanz starten → Mail mit 6-stelligem Code
4. Code in `cloudVerifyCode` → speichern → **einmal** neu starten
5. Log: `Printer connected` + `Token in lokaler Datei gespeichert`
6. JWT liegt in **`iobroker-data/bambulab.0/cloud-credentials.json`** (Admin-Feld „Cloud access token“ bleibt oft leer – normal)

**Kein neuer Code** bei normalem Neustart / `iobroker url`, solange Token-Datei existiert.

## Phasen-Roadmap (Merge → DrozmotiX #186)

| Phase | Inhalt | Status |
|-------|--------|--------|
| **0** | Fork, Branch, Test-Docker | erledigt |
| **1** | `lib/bambu-cloud.js` Login | erledigt |
| **2** | Cloud-MQTT, H2D pushall | erledigt (Test H2D) |
| **3** | Härtefälle (siehe Checkliste) | **in Arbeit** |
| **4** | README, upstream merge, WIP-PR | offen |

### Phase 3 – Checkliste (vor merge-ready PR)

- [x] E-Mail-Code-Login (Google/OAuth)
- [x] Token persistent (Datei + `cloudMqttUsername`)
- [x] JWT-Ablauf-Warnung im Log (~14 Tage vorher)
- [x] Cloud-`user_id` für MQTT-Befehle (keine Hardcodes mehr)
- [ ] **Manuell testen:** Pause / Stop / Resume über Cloud am H2D
- [ ] **Manuell testen:** optional Licht / Lüfter über Cloud
- [ ] 2FA: bewusst **nicht** implementiert – Doku/ Fehlermeldung (Workaround E-Mail-Code)
- [ ] Token-Refresh-API: **nicht** – Re-Login bei Ablauf (Doku)
- [ ] Region **China** untestiert dokumentieren
- [ ] **LAN-Regression:** kurzer Test `connectionMode = lan` (anderes Gerät oder zweite Instanz)
- [ ] `upstream/main` mergen, Konflikte lösen

### Phase 4 – danach

- README-Abschnitt Cloud (Limits: kein Kamera-Stream, kein Studio-Ersatz)
- WIP-PR an [DrozmotiX/ioBroker.bambulab](https://github.com/DrozmotiX/ioBroker.bambulab), Issue [#186](https://github.com/DrozmotiX/ioBroker.bambulab/issues/186)

## Adapter testen

- State: `bambulab.0.info.connection`
- Log-Level `info` reicht; H2D: weniger Spam ab cloud.12
