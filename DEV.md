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

## H2D Datenpunkte – Audit (Stand cloud.15)

**Serial-Ordner:** `bambulab.0.<serial>.*` – bei H2D kommen viele Felder unter `device.*` per jsonExplorer automatisch an (575+ States). Nur dokumentierte `state_attr`-Einträge haben schöne Namen/Rollen; der Rest ist lesbar, aber oft generisch benannt.

### Lesen – ok / bekannt

| Bereich | ioBroker-Pfad (Beispiel) | Hinweis |
|---------|--------------------------|---------|
| Druckstatus | `print.gcode_state`, `print.mc_percent`, `print.mc_remaining_time` | `stg_cur` wird als Text-Phase angezeigt (Bug Doppel-Konvertierung in .15 behoben) |
| Dual-Extruder | `device.extruder.info.0/1.temp`, Höhen, Speed | Roh-Temperaturen >500 werden ab .15 in °C umgerechnet |
| Airduct / Lüfter | `device.airduct.*`, `print.big_fan*_speed` | Prozent über `convert.fanSpeed`; H2D-Lüftungslogik liegt in `device.airduct`, nicht nur in `print.*` |
| AMS / Tray | `ams.*`, `vt_tray` | wie P1/X1 |
| HMS / Fehler | `print.hms.*` | Übersetzung wenn JSON geladen |
| Kamera / Laser-Cam | `device.cam.*` | **kein Live-Stream** (Adapter-Limit) |

### Steuern – funktioniert (Cloud/LAN)

| State unter `…control.*` | Aktion |
|--------------------------|--------|
| `pause`, `stop`, `resume` | MQTT print commands |
| `lightChamber` | H2D: `chamber_light` + `chamber_light2` |
| `lightWorkHead` | **neu ab .15:** `work_light` per `ledctrl` |
| `big_fan1_speed`, `big_fan2_speed`, `cooling_fan_speed` | G-code M106 P2/P3/P1 |
| `heatbreak_fan_speed` | **neu ab .15:** M106 P4 (manuell testen am H2D) |
| `bed_target_temper`, `nozzle_target_temper` | M140 / M104 – **nur eine** Soll-Düse, kein getrenntes L/R |
| `spd_lvl` | print_speed |
| `gcode` | G-code-Zeile (Sperre bei aktivem Druck) |
| `lightToolHeadLogo` | M960 (Logo-Licht, nicht Werklicht) |

### Kosmetik / Legacy

- `fanSpeedChamber` – alter Name, Handler bleibt (P3); aktiver State heißt `big_fan2_speed`.
- Viele `device.*`-States ohne `state_attr` – Werte stimmen, Namen/Rollen oft „roh“.

### Bewusst nicht / fehlt

- Live-Kamera, Bambu Studio, 2FA-Login
- Getrennte Soll-Temperatur Extruder L/R (nur `nozzle_target_temper` + `device.extruder.info.*.temp` lesen)
- Airduct-Modi schreiben (nur Anzeige der MQTT-Struktur)
- Vollständige H2D-`state_attr`-Map (Phase 4/Doku)

Nach Deploy `.15`: Instanz neu starten; optional alte `control.stg_cur`-Werte einmal aktualisieren lassen (pushall).
