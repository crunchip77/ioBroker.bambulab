'use strict';

/*
 * Created with @iobroker/create-adapter v2.4.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const fs = require('fs').promises;
const path = require('path');

const utils = require('@iobroker/adapter-core');

const mqtt = require('mqtt'); // MQTT request library
const { default: axios } = require('axios'); // Http request library

const jsonExplorer = require('iobroker-jsonexplorer'); // Use jsonExplorer library
const convert = require('./lib/converter'); // Load converter functions
const stateAttr = require(`${__dirname}/lib/state_attr.js`); // Load attribute library
const bambuCloud = require('./lib/bambu-cloud'); // LAN vs. Cloud MQTT (Fork)

let client; // Memory to store client connection information
const clientConnection = {
    connected: false,
    connectError: false,
    initiated: false,
    reconnectMessageShown: false, // Track if we've shown the reconnection message
    messageBuffer: false, // Track if message buffer is active
    /** Cloud: kein erneuter Login/Mail bis Nutzer Code oder Token in der Config hat */
    cloudAuthHold: false,
};
const timeouts = {}; // Object array containing all running timers
const errorCodesHMS = {}; // Object array of translated error codes
let language = 'en'; // System language to handle error code translations, default EN

// Array of G-code commands that should be blocked during printing for safety
const blockedCommandsDuringPrinting = ['G0', 'G1', 'G28', 'G90', 'G91'];
let currentPrintingState = null; // Track current printing state for safety checks
/** Bambu-Konto-ID für Cloud-MQTT (pushall) – aus JWT nach Login */
let cloudUserId = null;
/**
 * Frisch eingeloggt – Zugangsdaten erst nach MQTT-Connect in Config schreiben (Native-Update = Neustart).
 * Enthält auch cloudMqttUsername/cloudUserId, weil die Preference-API nach Neustart oft 401 liefert.
 */
let pendingCloudCredentialSave = null;

class Bambulab extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter configuration options
     */
    constructor(options) {
        super({
            ...options,
            name: 'bambulab',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
        jsonExplorer.init(this, stateAttr);
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize your adapter here

        // Get system language, use EN as fallback in case of errors
        const sys_conf = await this.getForeignObjectAsync('system.config');
        if (sys_conf && sys_conf.common.language) {
            language = sys_conf.common.language;
        }

        // Reset the connection indicator during startup
        await this.setState('info.connection', false, true);

        // Download / Update HMS error Codes
        await this.loadHMSErrorCodeTranslations();

        if ((this.config.connectionMode || 'lan') === 'cloud' && !(this.config.serial || '').trim()) {
            this.log.error(
                'Cloud: Seriennummer (serial) fehlt in der Instanz-Config – bitte im Admin eintragen und speichern, sonst kein MQTT und kein Token-Speichern.',
            );
        }

        if ((this.config.connectionMode || 'lan') === 'cloud') {
            await this.setObjectNotExistsAsync('control.cloudRequestEmailCode', {
                type: 'state',
                common: {
                    name: 'Cloud: E-Mail-Code erneut anfordern',
                    type: 'boolean',
                    role: 'button',
                    read: false,
                    write: true,
                },
                native: {},
            });
            await this.subscribeStatesAsync('control.cloudRequestEmailCode');
        }

        // Cloud-JWT aus Datei (Native-Verschlüsselung kann das MQTT-Passwort nach Neustart ungültig machen)
        await this.loadCloudCredentialsFromFile();
        if ((this.config.cloudUserId || '').trim()) {
            cloudUserId = String(this.config.cloudUserId).trim();
        }
        this.warnCloudTokenExpiry();

        // Handle MQTT messages (async: Cloud braucht vorher Login)
        this.mqttMessageHandle().catch(err => {
            if (err && (err.code === 'verifyCodeSent' || err.code === 'verifyCodePending')) {
                this.log.warn(err.message || err);
            } else {
                this.log.error(`MQTT setup failed: ${err.message || err}`);
            }
            clientConnection.initiated = false;
            clientConnection.connectError = true;
        });
    }

    /**
     * Baut MQTT-URL und Optionen – LAN (Drucker) oder Cloud (Bambu-Konto).
     */
    async resolveMqttConnect() {
        const logFn = (level, msg) => this.log[level](msg);
        let cloudEmailCodeRequestedAt = 0;
        try {
            const st = await this.getStateAsync('info.cloudEmailCodeRequestedAt');
            if (st && st.val != null && st.val !== '') {
                cloudEmailCodeRequestedAt = Number(st.val);
            }
        } catch {
            // State evtl. noch nicht angelegt
        }
        const connectConfig = {
            ...this.config,
            cloudEmailCodeRequestedAt,
            forceCloudEmailCodeRequest: !!this._forceCloudEmailCodeRequest,
        };
        this._forceCloudEmailCodeRequest = false;
        return bambuCloud.buildMqttConnect(connectConfig, logFn);
    }

    /** Merkt Zeitpunkt der letzten Code-Mail (State, kein Native-Update → kein Instanz-Neustart). */
    async markCloudEmailRequested() {
        await this.setState('info.cloudEmailCodeRequestedAt', Date.now(), true);
    }

    async clearCloudEmailRequestMarker() {
        await this.setState('info.cloudEmailCodeRequestedAt', 0, true);
    }

    /**
     * Handle MQTT connection & message
     */
    async mqttMessageHandle() {
        try {
            const modeEarly = this.config.connectionMode || 'lan';
            const hasCloudToken = !!(this.config.cloudAccessToken || '').trim();
            const hasCloudCode = !!(this.config.cloudVerifyCode || '').trim();
            if (modeEarly === 'cloud') {
                if (hasCloudToken || hasCloudCode) {
                    clientConnection.cloudAuthHold = false;
                } else if (clientConnection.cloudAuthHold) {
                    this.log.debug(
                        'Cloud: Warte auf E-Mail-Code oder Access Token in der Config – keine neue Mail, kein Retry.',
                    );
                    return;
                }
            }

            // Prevent multiple concurrent connection attempts
            if (clientConnection.initiated) {
                this.log.debug(`MQTT connection already in progress, skipping`);
                return;
            }

            // Only log connection attempt if we haven't shown the reconnect message yet
            if (!clientConnection.reconnectMessageShown) {
                if (clientConnection.connectError) {
                    this.log.info(
                        `Attempting to reconnect to printer - will retry automatically every 30 seconds until connection is restored`,
                    );
                    clientConnection.reconnectMessageShown = true;
                } else {
                    this.log.info(`Try to connect to printer`);
                }
            } else {
                this.log.debug(`Retrying connection to printer`);
            }

            clientConnection.initiated = true;

            // Properly close existing client if present
            if (client) {
                client.removeAllListeners();
                client.end();
                client = null;
            }

            const connect = await this.resolveMqttConnect();
            const mode = this.config.connectionMode || 'lan';

            // Cloud: user_id merken; Token erst NACH „Printer connected“ speichern (Native-Update = Instanz-Neustart)
            if (mode === 'cloud') {
                if (connect.accessToken) {
                    const stored = (this.config.cloudAccessToken || '').trim();
                    const usedVerifyCode = !!(this.config.cloudVerifyCode || '').trim();
                    const mqttUser = connect.mqttUsername || connect.options?.username || '';
                    const uid = connect.cloudUserId || '';
                    const needsSave =
                        usedVerifyCode ||
                        connect.accessToken !== stored ||
                        (mqttUser && mqttUser !== (this.config.cloudMqttUsername || '').trim()) ||
                        (uid && uid !== String(this.config.cloudUserId || '').trim());
                    if (needsSave) {
                        pendingCloudCredentialSave = {
                            accessToken: connect.accessToken,
                            cloudMqttUsername: mqttUser,
                            cloudUserId: uid,
                        };
                    }
                }
                if (connect.cloudUserId) {
                    cloudUserId = connect.cloudUserId;
                    this.log.debug(`Cloud user_id für pushall: ${cloudUserId}`);
                }
            }

            this.log.info(
                `MQTT ${mode === 'cloud' ? 'Cloud' : 'LAN'} → ${connect.url.replace(/\/\/.*@/, '//')}`,
            );

            // Connect to printer (LAN) or Bambu cloud broker
            client = mqtt.connect(connect.url, connect.options);

            // Establish connection to printer by MQTT
            client.on('connect', () => {
                if (!clientConnection.connected) {
                    this.log.info(`Printer connected successfully`);
                }
                this.setState('info.connection', true, true);
                clientConnection.connected = true;
                clientConnection.connectError = false;
                clientConnection.initiated = false; // Reset initiated flag on successful connection
                clientConnection.reconnectMessageShown = false; // Reset for future disconnections
                clientConnection.cloudAuthHold = false;

                // Cloud-Zugang persistent speichern (löst danach einen Neustart aus – MQTT war vorher schon OK)
                if (pendingCloudCredentialSave) {
                    const payload = pendingCloudCredentialSave;
                    pendingCloudCredentialSave = null;
                    this.saveCloudCredentials(payload).catch(err => {
                        this.log.error(
                            `Cloud: Zugangsdaten nach Connect nicht speicherbar: ${err.message || err} – bitte Serial prüfen und erneut mit E-Mail-Code anmelden.`,
                        );
                    });
                }

                this.createControlStates();

                // Subscribe on a printer topic after connection
                client.subscribe([`device/${this.config.serial}/report`], () => {
                    this.log.debug(`Subscribed to printer data topic by serial | ${this.config.serial}`);
                });

                // After new firmware release this summer all data must be requested 1 time at adapter start
                this.requestData();
            });

            // Receive MQTT messages
            client.on('message', (topic, message) => {
                // Parse string to an JSON object
                message = JSON.parse(message.toString());

                // @ts-expect-error if print does not exist function will return false and skip
                if (message && message.print && message && message.print.result) {
                    // Handle values for printer statistics
                    this.log.debug(`Printer message result ${JSON.stringify(message)}`);
                    // @ts-expect-error if system does not exist function will return false and skip
                } else if (message && message.print) {
                    this.log.debug(`Printer Message ${JSON.stringify(message)}`);
                    this.messageHandler(message);
                    // @ts-expect-error if system does not exist function will return false and skip
                } else if (message && message.command) {
                    this.log.info(`Response to control command ${JSON.stringify(message)}`);
                    // @ts-expect-error if system does not exist function will return false and skip
                } else if (message && message.system) {
                    // Handle values for system messages, used to acknowledge messages
                    this.log.debug(`System Message ${JSON.stringify(message)}`);
                } else if (message && message['t_utc']) {
                    // Handle values for system messages, used to acknowledge messages
                    // this.log.info(`System Message ${JSON.stringify(message)}`);
                    // TimeStamp Message, ignore
                } else {
                    this.log.debug(`Unknown Message ${JSON.stringify(message)}`);
                }
                clientConnection.connected = true;
                clientConnection.connectError = false;
            });

            client.on('end', () => {
                if (clientConnection.connected) {
                    this.log.warn(
                        `Printer connection lost - this could be due to printer being powered off or network issues`,
                    );
                }
                this.setState('info.connection', false, true);
                clientConnection.connected = false;
                clientConnection.connectError = true;
                clientConnection.initiated = false;
            });

            client.on('error', error => {
                if (!clientConnection.connectError) {
                    this.log.error(`Connection issue occurred: ${error} - printer may be powered off or unreachable`);
                }
                // Close MQTT connection
                client.end();
                if (clientConnection.connected) {
                    this.log.warn(
                        `Printer connection lost - this could be due to printer being powered off or network issues`,
                    );
                }
                this.setState('info.connection', false, true);

                // Try to reconnect by creating a new client instead of using reconnect()
                if (timeouts[this.config.serial]) {
                    this.clearTimeout(timeouts[this.config.serial]);
                    timeouts[this.config.serial] = null;
                }
                timeouts[this.config.serial] = this.setTimeout(() => {
                    if (clientConnection.cloudAuthHold) {
                        return;
                    }
                    // Create a new MQTT connection instead of reconnecting the ended client
                    this.mqttMessageHandle().catch(err => {
                        if (
                            err instanceof bambuCloud.BambuCloudAuthError &&
                            (err.code === 'verifyCodeSent' || err.code === 'verifyCodePending')
                        ) {
                            this.log.warn(err.message || err);
                        } else {
                            this.log.error(`MQTT reconnect failed: ${err.message || err}`);
                        }
                        clientConnection.initiated = false;
                    });
                }, 30000);
                clientConnection.connected = false;
                clientConnection.connectError = true;
                clientConnection.initiated = false;
            });
        } catch (e) {
            if (e instanceof bambuCloud.BambuCloudAuthError && e.code === 'verifyCodeSent') {
                // Kein Fehler: Bambu hat Code per Mail geschickt, Nutzer muss ihn eintragen
                this.log.warn(e.message || e);
                await this.markCloudEmailRequested();
                clientConnection.cloudAuthHold = true;
            } else if (e instanceof bambuCloud.BambuCloudAuthError && e.code === 'verifyCodePending') {
                this.log.warn(e.message || e);
                clientConnection.cloudAuthHold = true;
            } else if (e instanceof bambuCloud.BambuCloudAuthError && e.code === 'codeIncorrect') {
                this.log.error(e.message || e);
                clientConnection.cloudAuthHold = true;
            } else if (e instanceof bambuCloud.BambuCloudAuthError && e.code === 'codeExpired') {
                this.log.warn(`${e.message} Alten Code aus der Config entfernen und neue Mail anfordern…`);
                await this.recoverFromExpiredEmailCode();
            } else if (e instanceof bambuCloud.BambuCloudAuthError && e.code === 'emailCodeFailed') {
                this.log.error(e.message || e);
                clientConnection.cloudAuthHold = true;
            } else if (e instanceof bambuCloud.BambuCloudAuthError && e.code === 'tokenInvalid') {
                this.log.error(e.message || e);
                this.config.cloudAccessToken = '';
                await this.clearCloudCredentialsFile();
                clientConnection.cloudAuthHold = true;
                this.log.warn(
                    'Im Admin „Cloud access token“ leeren und speichern (kein Auto-Neustart). Dann Instanz starten – eine E-Mail mit Code.',
                );
            } else {
                this.log.error(`[MQTT Message handler] ${e} | ${e.stack}`);
            }
            clientConnection.initiated = false;
        }
    }

    /**
     * Native-Felder der eigenen Instanz patchen (system.adapter.bambulab.0).
     *
     * WICHTIG: getForeignObjectAsync().native enthält oft KEINE protected/encrypted Felder
     * (serial, cloudAccessToken, …). Nur this.config als Basis nutzen – sonst gehen sie verloren
     * → NO_ADAPTER_CONFIG_FOUND.
     */
    async mergeCloudNativePatch(patch) {
        const id = `system.adapter.${this.namespace}`;
        if (!(this.config.serial || '').trim()) {
            throw new Error(
                'Seriennummer fehlt in der laufenden Config – Native wird nicht überschrieben. Bitte im Admin unter „Serial“ eintragen.',
            );
        }
        const native = { ...this.config, ...patch };
        await this.extendForeignObjectAsync(id, { native });
        Object.assign(this.config, patch);
    }

    /** Dateiname in iobroker-data/<instanz>/ – überlebt `iobroker url` (nicht node_modules). */
    cloudCredentialsFileName() {
        return 'cloud-credentials.json';
    }

    /** Persistenter Pfad: /opt/iobroker/iobroker-data/bambulab.0/cloud-credentials.json */
    cloudCredentialsFilePath() {
        return path.join(utils.getAbsoluteInstanceDataDir(this), this.cloudCredentialsFileName());
    }

    /** Alte Fork-Version: Token lag im Adapter-Ordner und ging bei jedem Update verloren. */
    legacyCloudCredentialsFilePath() {
        return path.join(this.adapterDir, this.cloudCredentialsFileName());
    }

    parseCloudCredentialsJson(raw) {
        const cred = JSON.parse(raw);
        const token = (cred.accessToken || '').trim();
        if (!token) {
            return null;
        }
        return {
            accessToken: token,
            cloudMqttUsername: cred.cloudMqttUsername
                ? String(cred.cloudMqttUsername).trim()
                : '',
            cloudUserId: cred.cloudUserId != null ? String(cred.cloudUserId).trim() : '',
        };
    }

    applyCloudCredentialsToConfig(cred) {
        this.config.cloudAccessToken = cred.accessToken;
        if (cred.cloudMqttUsername) {
            this.config.cloudMqttUsername = cred.cloudMqttUsername;
        }
        if (cred.cloudUserId) {
            this.config.cloudUserId = cred.cloudUserId;
        }
        this.log.debug(`Cloud: Zugangsdaten aus Datei (Token-Länge ${cred.accessToken.length}).`);
    }

    /**
     * JWT + MQTT-User aus Instanz-Datei laden (hat Vorrang vor Native cloudAccessToken).
     */
    async loadCloudCredentialsFromFile() {
        if ((this.config.connectionMode || 'lan') !== 'cloud') {
            return;
        }
        try {
            const raw = await fs.readFile(this.cloudCredentialsFilePath(), 'utf8');
            const cred = this.parseCloudCredentialsJson(raw);
            if (cred) {
                this.applyCloudCredentialsToConfig(cred);
            }
            return;
        } catch (err) {
            if (err && err.code !== 'ENOENT') {
                this.log.warn(`Cloud: Instanz-Zugangsdaten nicht lesbar: ${err.message || err}`);
            }
        }

        // Migration: einmalig aus altem Pfad unter node_modules/iobroker.bambulab/
        try {
            const raw = await fs.readFile(this.legacyCloudCredentialsFilePath(), 'utf8');
            const cred = this.parseCloudCredentialsJson(raw);
            if (!cred) {
                return;
            }
            await this.writeCloudCredentialsFile(cred);
            this.applyCloudCredentialsToConfig(cred);
            this.log.info(
                'Cloud: Token aus altem Adapter-Ordner nach iobroker-data verschoben – künftig kein E-Mail-Code mehr nach `iobroker url`.',
            );
            try {
                await fs.unlink(this.legacyCloudCredentialsFilePath());
            } catch {
                // ignore
            }
        } catch (err) {
            if (err && err.code !== 'ENOENT') {
                this.log.debug(`Cloud: Keine Legacy-Zugangsdaten: ${err.message || err}`);
            }
        }
    }

    async writeCloudCredentialsFile({ accessToken, cloudMqttUsername, cloudUserId }) {
        const payload = {
            accessToken: (accessToken || '').trim(),
            cloudMqttUsername: (cloudMqttUsername || '').trim(),
            cloudUserId: cloudUserId != null ? String(cloudUserId).trim() : '',
            savedAt: Date.now(),
        };
        await fs.writeFile(this.cloudCredentialsFilePath(), JSON.stringify(payload), {
            encoding: 'utf8',
            mode: 0o600,
        });
    }

    async clearCloudCredentialsFile() {
        try {
            await fs.unlink(this.cloudCredentialsFilePath());
        } catch (err) {
            if (err && err.code !== 'ENOENT') {
                this.log.warn(`Cloud: Instanz-Zugangsdaten nicht löschbar: ${err.message || err}`);
            }
        }
        try {
            await fs.unlink(this.legacyCloudCredentialsFilePath());
        } catch {
            // ignore
        }
    }

    /**
     * Nach erfolgreichem Cloud-MQTT: Token in Datei, MQTT-User in Native, E-Mail-Code löschen.
     * JWT nicht in encryptedNative speichern – ioBroker kann es verfälschen → MQTT „Not authorized“.
     */
    async saveCloudCredentials({ accessToken, cloudMqttUsername, cloudUserId }) {
        const token = (accessToken || '').trim();
        if (!token) {
            return;
        }
        const mqttUser = (cloudMqttUsername || '').trim();
        const uid = cloudUserId != null ? String(cloudUserId).trim() : '';

        await this.writeCloudCredentialsFile({
            accessToken: token,
            cloudMqttUsername: mqttUser,
            cloudUserId: uid,
        });

        const patch = {
            cloudVerifyCode: '',
            cloudAccessToken: '',
        };
        if (mqttUser && /^u_\d+$/.test(mqttUser)) {
            patch.cloudMqttUsername = mqttUser;
        }
        if (uid && /^\d+$/.test(uid)) {
            patch.cloudUserId = uid;
        }

        await this.mergeCloudNativePatch(patch);
        this.config.cloudAccessToken = token;
        await this.clearCloudEmailRequestMarker();
        clientConnection.cloudAuthHold = false;
        this.log.info(
            `Cloud: Token in ${this.cloudCredentialsFilePath()} gespeichert, MQTT-User in Config – künftig kein E-Mail-Code bei Neustart/url (bis JWT abläuft).`,
        );
    }

    /** Abgelaufenen oder falschen Einmal-Code aus der Instanz-Config entfernen */
    async clearCloudVerifyCode() {
        if (!(this.config.cloudVerifyCode || '').trim()) {
            return;
        }
        await this.mergeCloudNativePatch({ cloudVerifyCode: '' });
    }

    /**
     * Bambu lehnt abgelaufene Codes ab, solange sie noch in cloudVerifyCode stehen wird keine neue Mail angefordert.
     * Code löschen, Cooldown zurücksetzen, direkt neue Mail auslösen (ohne manuelles Admin-Leeren).
     */
    async recoverFromExpiredEmailCode() {
        await this.forceCloudEmailCodeRequest();
    }

    /** Cooldown umgehen, alten Code verwerfen, Bambu sendemail/code direkt aufrufen. */
    async forceCloudEmailCodeRequest() {
        if ((this.config.connectionMode || 'lan') !== 'cloud') {
            return;
        }
        const email = (this.config.cloudEmail || '').trim();
        if (!email) {
            this.log.error('Cloud: Bambu-E-Mail (cloudEmail) fehlt – keine Code-Mail möglich.');
            return;
        }
        this.config.cloudVerifyCode = '';
        clientConnection.cloudAuthHold = false;
        clientConnection.initiated = false;
        await this.clearCloudEmailRequestMarker();
        try {
            await this.clearCloudVerifyCode();
        } catch (err) {
            this.log.warn(
                `Cloud: Alten Code nicht in Native speicherbar (${err.message || err}) – Feld im Admin leeren, speichern.`,
            );
        }
        this._forceCloudEmailCodeRequest = true;
        try {
            await this.mqttMessageHandle();
        } catch (retryErr) {
            if (
                retryErr instanceof bambuCloud.BambuCloudAuthError &&
                (retryErr.code === 'verifyCodeSent' || retryErr.code === 'verifyCodePending')
            ) {
                this.log.warn(retryErr.message || retryErr);
            } else if (!(retryErr instanceof bambuCloud.BambuCloudAuthError)) {
                this.log.error(`Cloud: E-Mail-Anforderung fehlgeschlagen: ${retryErr.message || retryErr}`);
            }
        }
    }

    /**
     * Handle MQTT messages to ioBroker states
     *
     * @param {object} message - MQTT message to process
     */
    async messageHandler(message) {
        try {
            // Implement message buffer to avoid processing too many messages in a short time
            if (clientConnection.messageBuffer === false) {
                try {
                    this.log.debug(`Message buffer inactive, message processing`);
                    if (this.config.messageBuffer > 0) {
                        clientConnection.messageBuffer = true;
                        timeouts['messageBuffer'] = this.setTimeout(() => {
                            // Request data for P1p printer series
                            clientConnection.messageBuffer = false;
                        }, this.config.messageBuffer * 1000);
                    }
                } catch (e) {
                    this.log.error(`[MQTT Message handler] ${e}`);
                }
            } else {
                this.log.debug(`Message buffer active, skipping message processing`);
                return; // Ignore Message
            }

            if (message.print) {
                // H2D meldet Düsen-Temperaturen oft als große Rohwerte – vor jsonExplorer normalisieren
                this.normalizeH2dPrintTemperatures(message.print);

                // Modify values of JSON for states which need modification
                message.print.control = {};
                if (message.print.cooling_fan_speed != null) {
                    message.print.cooling_fan_speed = convert.fanSpeed(message.print.cooling_fan_speed);
                    message.print.control.cooling_fan_speed = message.print.cooling_fan_speed;
                }
                if (message.print.heatbreak_fan_speed != null) {
                    message.print.heatbreak_fan_speed = convert.fanSpeed(message.print.heatbreak_fan_speed);
                    message.print.control.heatbreak_fan_speed = message.print.heatbreak_fan_speed;
                }
                // Store original stg_cur value for printer state checking before conversion
                const originalStgCur = message.print.stg_cur;

                // Update current printing state for safety checks
                currentPrintingState = originalStgCur;

                if (message.print.stg_cur != null) {
                    const stgCurLabel = convert.stageParser(originalStgCur);
                    message.print.stg_cur = stgCurLabel;
                    message.print.control.stg_cur = stgCurLabel;
                }
                if (message.print.big_fan1_speed != null) {
                    message.print.big_fan1_speed = convert.fanSpeed(message.print.big_fan1_speed);
                    message.print.control.big_fan1_speed = message.print.big_fan1_speed;
                }
                if (message.print.big_fan2_speed != null) {
                    message.print.big_fan2_speed = convert.fanSpeed(message.print.big_fan2_speed);
                    message.print.control.big_fan2_speed = message.print.big_fan2_speed;
                }
                if (message.print.spd_lvl != null) {
                    message.print.control.spd_lvl = message.print.spd_lvl;
                }
                if (message.print.bed_target_temper != null) {
                    message.print.control.bed_target_temper = message.print.bed_target_temper;
                }
                if (message.print.nozzle_target_temper != null) {
                    message.print.control.nozzle_target_temper = message.print.nozzle_target_temper;
                }
                if (message.print.mc_remaining_time != null) {
                    // Only calculate finish time when printer is actively printing (not idle/offline)
                    // stg_cur values:
                    //   -2 = Offline
                    //   -1 = Idle
                    //    0 = Preparing
                    //    1 = Printing
                    //    2 = Paused
                    //    3 = Completed
                    //    4+ = Other working states (update as needed)
                    if (originalStgCur != null && originalStgCur >= 0) {
                        message.print.finishTime = new Date(
                            new Date().getTime() + message.print.mc_remaining_time * 60000,
                        ).toISOString();
                    } else {
                        // Clear finish time when printer is idle/offline to avoid stale data
                        message.print.finishTime = '';
                    }
                    message.print.mc_remaining_time = convert.remainingTime(message.print.mc_remaining_time);
                }

                if (message.print.gcode_start_time != null) {
                    let gcode_start_timeFormatted = new Date(message.print.gcode_start_time * 1000).toString();
                    gcode_start_timeFormatted = gcode_start_timeFormatted.replace('"', '');
                    message.print.gcode_start_timeFormatted = gcode_start_timeFormatted;
                }
                if (message.print.vt_tray != null && message.print.vt_tray.bed_temp != null) {
                    message.print.vt_tray.bed_temp = +message.print.vt_tray.bed_temp;
                }
                // lights_report → Schreib-States (Kammer + Werklicht)
                this.syncLightsReportToControl(message.print);

                // Translate HMS Code & write to state
                const hmsError = [];
                if (message.print.hms != null) {
                    message.print.hms.hmsErrors = true;
                    for (const hms_code in message.print.hms) {
                        const attr = convert.DecimalHexTwosComplement(message.print.hms[hms_code].attr);
                        const code = convert.DecimalHexTwosComplement(message.print.hms[hms_code].code);

                        let full_code = (attr + code).replace(/(.{4})/g, '$1_');
                        full_code = full_code.substring(0, full_code.length - 1);
                        const urlEN = `https://wiki.bambulab.com/en/x1/troubleshooting/hmscode/${full_code}`;

                        let errorDesc = 'No description available in your language';
                        if (
                            errorCodesHMS[full_code.replaceAll('_', '').toUpperCase()] != null &&
                            errorCodesHMS[full_code.replaceAll('_', '').toUpperCase()]['desc'] != null
                        ) {
                            errorDesc = errorCodesHMS[full_code.replaceAll('_', '').toUpperCase()]['desc'];
                        }
                        const errorMessageArray = { code: `HMS_${full_code}`, 'url-EN': urlEN, description: errorDesc };
                        if (language.toUpperCase() !== 'EN') {
                            errorMessageArray['url-local'] =
                                `https://wiki.bambulab.com/${language}/x1/troubleshooting/hmscode/${full_code}`;
                        }
                        hmsError.push(errorMessageArray);
                    }
                } else {
                    message.print.hms = {
                        hmsErrorCount: 0,
                        hmsErrors: false,
                    };
                }

                await this.setState(`${this.config.serial}.hms.hmsErrorCode`, {
                    val: JSON.stringify(hmsError),
                    ack: true,
                });

                // For some reason library does not convert the ams related bed_temp to number when value = 0
                if (
                    message.print.ams != null &&
                    message.print.ams.ams_exist_bits != null &&
                    message.print.ams.ams_exist_bits === '1'
                ) {
                    // Call function to handle states for AMS unit
                    message.print.ams.ams = this.handleAMSUnits(message);
                }
            }

            // Translate home_flag to door state
            if (message.print.home_flag === 14796168) {
                message.print.doorOpen = true;
            } else if (message.print.home_flag === 6407560) {
                message.print.doorOpen = false;
            }

            // Typ-Korrektur vor jsonExplorer (sonst ioBroker info: „has to be type …“)
            if (message.print.err2 && message.print.err2.err_code != null) {
                const c = message.print.err2.err_code;
                if (typeof c === 'string' && c !== '' && !Number.isNaN(Number(c))) {
                    message.print.err2.err_code = Number(c);
                }
            }
            const nozzle = message.print.device && message.print.device.nozzle;
            if (nozzle && nozzle.tar_id != null && typeof nozzle.tar_id !== 'number') {
                const n = Number(nozzle.tar_id);
                if (!Number.isNaN(n)) {
                    nozzle.tar_id = n;
                }
            }

            // H2D sendet viele Felder, die in state_attr.js (noch) fehlen – ohne validateAttribute kein Sentry-/Warn-Spam
            const strictStateAttr = !/^H2D/i.test(this.config.printerModel || '');

            // Explore JSON & create states
            const returnJONexplorer = await jsonExplorer.traverseJson(
                message.print,
                this.config.serial,
                false,
                false,
                0,
                strictStateAttr,
            );
            this.log.debug(`Response of JSONexploer: ${JSON.stringify(returnJONexplorer)}`);
        } catch (e) {
            this.log.error(`[messageHandler] ${e} | ${e.stack}`);
        }
        clientConnection.initiated = true;
    }

    handleAMSUnits(message) {
        const amsData = message.print.ams.ams;
        // handle conversion for all AMS units
        for (const unit in amsData) {
            if (amsData[unit] !== null) {
                for (const tray in amsData[unit].tray) {
                    if (!amsData[unit].tray[tray].cols) {
                        // amsData[unit].tray[tray] =   {
                        // 	'bed_temp': '',
                        // 	'bed_temp_type': '',
                        // 	'cols': [],
                        // 	'drying_temp': '',
                        // 	'drying_time': '',
                        // 	'id': '',
                        // 	'nozzle_temp_max': '',
                        // 	'nozzle_temp_min': '',
                        // 	'remain': 0,
                        // 	'tag_uid': '',
                        // 	'tray_color': '',
                        // 	'tray_diameter': '',
                        // 	'tray_id_name': '',
                        // 	'tray_info_idx': '',
                        // 	'tray_sub_brands': '',
                        // 	'tray_type': '',
                        // 	'tray_uuid': '',
                        // 	'tray_weight': '',
                        // 	'xcam_info': ''
                        // };
                        // amsData[unit].tray[tray]._filamentPresent = false;
                    } else {
                        // amsData[unit].tray[tray]._filamentPresent = true;
                        amsData[unit].tray[tray].bed_temp = parseInt(amsData[unit].tray[tray].bed_temp);
                    }
                    if (amsData[unit].tray[tray].bed_temp != null) {
                        amsData[unit].tray[tray].bed_temp = parseInt(amsData[unit].tray[tray].bed_temp);
                    }
                }
            }
        }
        return amsData;
    }

    /**
     * Bambu user_id für pushall / system-Befehle (Cloud: aus Login, LAN: Platzhalter wie bisher).
     */
    mqttCommandUserId() {
        const fromConfig = cloudUserId || String(this.config.cloudUserId || '').trim();
        if (fromConfig) {
            return fromConfig;
        }
        return '1234567890';
    }

    /** Cloud-MQTT: user_id an Wurzel setzen, wo Bambu es erwartet (nicht fest verdrahtet). */
    applyMqttUserId(msg) {
        if (!msg || (this.config.connectionMode || 'lan') !== 'cloud') {
            return msg;
        }
        const uid = this.mqttCommandUserId();
        if (uid === '1234567890') {
            this.log.warn(
                'Cloud: user_id fehlt – Steuerbefehle können fehlschlagen. Einmal Cloud-Login (E-Mail-Code) durchführen.',
            );
        }
        if (msg.user_id == null) {
            msg.user_id = uid;
        }
        if (msg.print && msg.print.user_id == null) {
            msg.print.user_id = uid;
        }
        return msg;
    }

    /** Vor Ablauf des Cloud-JWT warnen (kein Auto-Refresh – Nutzer meldet sich neu an). */
    warnCloudTokenExpiry() {
        if ((this.config.connectionMode || 'lan') !== 'cloud') {
            return;
        }
        const token = (this.config.cloudAccessToken || '').trim();
        if (!token) {
            return;
        }
        const days = bambuCloud.accessTokenDaysUntilExpiry(token);
        if (days === 0) {
            this.log.warn(
                'Cloud Access Token ist abgelaufen (JWT) – Token leeren, speichern, Instanz starten, E-Mail-Code eintragen.',
            );
        } else if (days != null && days <= 14) {
            this.log.warn(`Cloud Access Token läuft in ca. ${days} Tag(en) ab – rechtzeitig neu anmelden.`);
        }
    }

    /** H2D meldet Düsen-Temperaturen teils als Encoder-Rohwert (>500) statt °C. */
    decodeExtruderTempValue(raw) {
        if (raw == null || typeof raw !== 'number') {
            return raw;
        }
        if (raw > 500) {
            return Math.round(raw / 58100);
        }
        return raw;
    }

    normalizeH2dPrintTemperatures(print) {
        if (!/^H2D/i.test(this.config.printerModel || '') || !print) {
            return;
        }
        const infos = print.device?.extruder?.info;
        if (Array.isArray(infos)) {
            for (const ex of infos) {
                if (ex && ex.temp != null) {
                    ex.temp = this.decodeExtruderTempValue(ex.temp);
                }
            }
        }
        if (print.nozzle_temper != null) {
            print.nozzle_temper = this.decodeExtruderTempValue(print.nozzle_temper);
        }
        if (print.nozzle_target_temper != null) {
            print.nozzle_target_temper = this.decodeExtruderTempValue(print.nozzle_target_temper);
        }
    }

    /** H2D: zwei LED-Leisten (chamber_light + chamber_light2), sonst eine. */
    usesDualChamberLights() {
        return /^H2D/i.test(this.config.printerModel || '');
    }

    chamberLightLedNodes() {
        return this.usesDualChamberLights() ? ['chamber_light', 'chamber_light2'] : ['chamber_light'];
    }

    buildChamberLedCtrlMessage(ledNode, turnOn) {
        return {
            system: {
                sequence_id: '2003',
                command: 'ledctrl',
                led_node: ledNode,
                led_mode: turnOn ? 'on' : 'off',
                led_on_time: 500,
                led_off_time: 500,
                loop_times: 0,
                interval_time: 0,
            },
        };
    }

    /** Ein Schalter: alle Kammer-LED-Kanäle des Modells schalten (wie Bambu-App). */
    publishChamberLightCommand(turnOn) {
        for (const node of this.chamberLightLedNodes()) {
            this.publishMQTTmessages(this.buildChamberLedCtrlMessage(node, turnOn));
        }
    }

    /**
     * lights_report → control.* (Schreib-States spiegeln MQTT).
     * H2D Kammer: mindestens eine LED „on“ → lightChamber true.
     * Werklicht: node work_light → lightWorkHead.
     */
    syncLightsReportToControl(print) {
        if (!print || !Array.isArray(print.lights_report)) {
            return;
        }
        if (!print.control) {
            print.control = {};
        }

        const nodes = new Set(this.chamberLightLedNodes());
        const chamberLights = print.lights_report.filter(entry => entry && nodes.has(entry.node));
        if (chamberLights.length) {
            const anyOn = chamberLights.some(entry => entry.mode === 'on' || entry.mode === 'flashing');
            print.control.lightChamber = anyOn;
            for (const entry of chamberLights) {
                entry.mode = entry.mode === 'on' || entry.mode === 'flashing';
            }
        }

        const workLight = print.lights_report.find(entry => entry && entry.node === 'work_light');
        if (workLight) {
            print.control.lightWorkHead = workLight.mode === 'on' || workLight.mode === 'flashing';
            workLight.mode = workLight.mode === 'on' || workLight.mode === 'flashing';
        }
    }

    publishMQTTmessages(msg) {
        msg = this.applyMqttUserId(msg);
        this.log.debug(`Publish message ${JSON.stringify(msg)}`);

        const topic = `device/${this.config.serial}/request`;
        client.publish(topic, JSON.stringify(msg), { qos: 0, retain: false }, error => {
            if (error) {
                console.error(error);
            }
        });
    }

    requestData() {
        // Cloud: echte Bambu-user_id; LAN: Platzhalter reicht oft, Cloud eher nicht
        // Prepare MQTT message
        const msg = {
            pushing: {
                sequence_id: '1',
                command: 'pushall',
            },
            user_id: this.mqttCommandUserId(),
        };

        // Try to request data
        this.publishMQTTmessages(msg);

        // Handle an interval only if not X1-Series
        if (timeouts['dataPolling']) {
            this.clearTimeout(timeouts['dataPolling']);
            timeouts['dataPolling'] = null;
        }
        timeouts['dataPolling'] = this.setTimeout(() => {
            // P1/H2D: Drucker pusht nicht ständig – Status per Intervall anfordern
            const pollModels = ['P1-Series', 'H2D-Series'];
            if (pollModels.includes(this.config.printerModel)) {
                this.requestData();
            }
        }, this.config.requestInterval * 1000);
    }

    createControlStates() {
        const controlStates = {
            homing: {
                name: 'Homing print head',
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
            },
            _customGcode: {
                name: 'Custom G-Code',
                type: 'string',
                role: 'state',
                read: true,
                write: true,
                def: '',
            },
            lightToolHeadLogo: {
                name: 'Tool head Logo',
                type: 'boolean',
                role: 'state',
                read: true,
                write: true,
                def: false,
            },
            pause: {
                name: 'Pause printing',
                type: 'boolean',
                role: 'button.pause',
                read: false,
                write: true,
            },
            stop: {
                name: 'Stop Printing',
                type: 'boolean',
                role: 'button.stop',
                read: false,
                write: true,
            },
            resume: {
                name: 'Resume Printing',
                type: 'boolean',
                role: 'button.resume',
                read: false,
                write: true,
            },
            updateHMSErrorCodeTranslation: {
                name: 'Update HMS error code translations',
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
            },
        };

        const hmstates = {
            hmsErrorCode: {
                role: 'indicator.maintenance',
                name: 'Health Management System (HMS)',
                type: 'string',
                read: true,
                write: false,
                def: '',
            },
            hmsErrorCount: {
                role: 'indicator.maintenance',
                name: 'HMS Alarm count',
                type: 'number',
                read: true,
                write: false,
                def: 0,
            },
            hmsErrors: {
                role: 'indicator.alarm',
                name: 'HMS Alarm ',
                type: 'boolean',
                read: true,
                write: false,
                def: false,
            },
        };

        this.extendObject(`${this.config.serial}.control`, {
            type: 'channel',
            common: {
                name: `Control device`,
            },
        });

        for (const state in controlStates) {
            this.extendObject(`${this.config.serial}.control.${state}`, {
                type: 'state',
                common: controlStates[state],
            });

            this.subscribeStates(`${this.config.serial}.control.${state}`);
        }

        for (const state in hmstates) {
            this.extendObject(`${this.config.serial}.hms.${state}`, {
                type: 'state',
                common: hmstates[state],
            });
        }
    }

    async loadHMSErrorCodeTranslations() {
        try {
            this.log.info('Try to get current HMS code translations');

            // Web request to download latest translations
            const requestDeviceDataByAPI = async () => {
                const response = await axios.get(`https://e.bambulab.com/query.php?lang=${language}`, {
                    timeout: 3000,
                }); // Timout of 3 seconds for API call
                this.log.debug(JSON.stringify(`HMS ErrorCode translations : ${response.data}`));
                return response.data;
            };

            const loadTranslationsToMemory = async tranJSON => {
                for (const errorType in tranJSON) {
                    for (const errorCode in tranJSON[errorType][language]) {
                        if (
                            tranJSON[errorType][language][errorCode] != null &&
                            tranJSON[errorType][language][errorCode].ecode != null
                        ) {
                            errorCodesHMS[tranJSON[errorType][language][errorCode].ecode.toUpperCase()] = {
                                ecode: tranJSON[errorType][language][errorCode].ecode,
                                desc: tranJSON[errorType][language][errorCode].intro,
                            };
                        }
                    }
                }
            };

            // Try to download new translation JSON, abort function in case of error
            const onlineTran = await requestDeviceDataByAPI();
            if (onlineTran == null || onlineTran.data == null) {
                this.log.warn(`Cannot download HMS error code translations`);
                return false;
            }

            const onlineTranObj = onlineTran.data;
            onlineTranObj.ver = onlineTran.ver;
            onlineTranObj.language = language.toUpperCase();

            // get current Translations
            const currentTran = await this.getStateAsync('info.hmsErrorCodeTranslations');

            if (currentTran == null || currentTran.val === '') {
                this.log.info(`No Local translation available, version ${onlineTran.ver} downloaded`);
                this.setStateAsync(`info.hmsErrorCodeTranslations`, { val: JSON.stringify(onlineTranObj), ack: true });
                await loadTranslationsToMemory(onlineTranObj);
            } else if (typeof currentTran.val === 'string' && currentTran.val !== '') {
                const currentTranObj = JSON.parse(currentTran.val);
                // Check if new version is available
                if (currentTranObj.ver !== onlineTran.ver) {
                    this.log.info(`Local translation ${currentTranObj.ver} outdated, updating to ${onlineTran.ver}`);
                    this.setStateAsync(`info.hmsErrorCodeTranslations`, {
                        val: JSON.stringify(onlineTranObj),
                        ack: true,
                    });
                    await loadTranslationsToMemory(onlineTranObj);
                } else if (currentTranObj.language.toUpperCase() !== language.toUpperCase()) {
                    this.log.info(
                        `Local translation ${currentTranObj.language} incorrect, updating to ${language.toUpperCase()}`,
                    );
                    this.setStateAsync(`info.hmsErrorCodeTranslations`, {
                        val: JSON.stringify(onlineTranObj),
                        ack: true,
                    });
                    loadTranslationsToMemory(onlineTranObj);
                } else {
                    this.log.info(`Local translation available, version ${currentTranObj.ver} is up-to-date`);
                    loadTranslationsToMemory(currentTranObj);
                }
            }
        } catch (e) {
            if (e.code === 'ECONNABORTED' || e.message.includes('timeout')) {
                this.log.warn(
                    `Translation definitions not updated, cannot connect to Bambulab documentation (timeout)`,
                );
                this.log.debug(`[loadHMSErrorCodeTranslations] Timeout details: ${e.message}`);
            } else if (e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED') {
                this.log.warn(
                    `Translation definitions not updated, cannot connect to Bambulab documentation (network error)`,
                );
                this.log.debug(`[loadHMSErrorCodeTranslations] Network error details: ${e.message}`);
            } else {
                this.log.warn(`Translation definitions not updated, error downloading from Bambulab documentation`);
                this.log.debug(`[loadHMSErrorCodeTranslations] Error details: ${e.message} | ${e.stack}`);
            }
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param {() => void} callback - Callback function to signal shutdown completion
     */
    onUnload(callback) {
        try {
            // Close running timers
            if (timeouts[this.config.serial]) {
                this.clearTimeout(timeouts[this.config.serial]);
                timeouts[this.config.serial] = null;
            }
            if (timeouts['dataPolling']) {
                this.clearTimeout(timeouts['dataPolling']);
                timeouts[timeouts['dataPolling']] = null;
            }

            if (timeouts['messageBuffer']) {
                this.clearTimeout(timeouts['messageBuffer']);
                timeouts['messageBuffer'] = null;
            }

            // Close MQTT connection if present
            if (client) {
                client.end();
            }

            callback();
        } catch (e) {
            this.log.error(`[onUnload] ${e} | ${e.stack}`);
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     *
     * @param {string} id - State ID that changed
     * @param {ioBroker.State | null | undefined} state - New state value
     */
    /**
     * Check if printer is currently in a state where dangerous G-code commands should be blocked
     *
     * @returns {boolean} True if dangerous G-code should be blocked
     */
    isPrintingOrActiveState() {
        // Block dangerous commands when printer is actively working
        // Based on stg_cur values:
        //   -2 = Offline (safe)
        //   -1 = Idle (safe)
        //    0+ = Active working states (potentially dangerous)
        return currentPrintingState != null && currentPrintingState >= 0;
    }

    /**
     * Check if a G-code command should be blocked during printing
     *
     * @param {string|number} gcodeParam - The G-code command parameter
     * @returns {boolean} True if command should be blocked
     */
    shouldBlockGcodeCommand(gcodeParam) {
        if (!this.isPrintingOrActiveState()) {
            return false; // Allow all commands when not actively working
        }

        // Convert to string and check if any blocked command is present
        const upperParam = String(gcodeParam).toUpperCase().trim();
        return blockedCommandsDuringPrinting.some(
            blockedCmd =>
                upperParam.startsWith(`${blockedCmd} `) ||
                upperParam === blockedCmd ||
                upperParam.startsWith(`${blockedCmd}\n`),
        );
    }

    async onStateChange(id, state) {
        if (state && state.val != null) {
            // Only act on trigger if value is not Acknowledged
            if (!state.ack) {
                console.debug(`${id} | ${state.val}`);
                let msg;
                const checkID = id.split('.');

                //ToDo: Implement ACK based on success message of MQTT in relation to sequence ID.
                // Handle control states

                let stateLocation = 3;
                if (checkID[3] === 'control') {
                    stateLocation = 4;
                }

                switch (checkID[stateLocation]) {
                    case 'cloudRequestEmailCode':
                        if (state.val) {
                            await this.forceCloudEmailCodeRequest();
                        }
                        return;
                    case '_customGcode':
                        // Check if this G-code command should be blocked during printing
                        if (this.shouldBlockGcodeCommand(state.val)) {
                            this.log.warn(
                                `Blocked dangerous G-code command "${state.val}" during active printing/working state (stg_cur: ${currentPrintingState}). Command ignored for safety.`,
                            );
                            return; // Exit without sending the command
                        }

                        msg = msg = {
                            print: {
                                command: 'gcode_line',
                                param: `${state.val}`,
                                sequence_id: '0',
                            },
                        };
                        break;
                    case 'lightChamber':
                        if (state.val === true) {
                            this.publishChamberLightCommand(true);
                        } else if (state.val === false) {
                            this.publishChamberLightCommand(false);
                        }
                        return;
                    case 'lightWorkHead':
                        if (state.val === true || state.val === false) {
                            this.publishMQTTmessages(
                                this.buildChamberLedCtrlMessage('work_light', state.val === true),
                            );
                        }
                        return;
                    case 'lightToolHeadLogo':
                        if (state.val === true) {
                            msg = msg = {
                                print: {
                                    command: 'gcode_line',
                                    param: `M960 S5 P1 \n`,
                                    sequence_id: '0',
                                },
                            };
                        } else if (state.val === false) {
                            msg = msg = {
                                print: {
                                    command: 'gcode_line',
                                    param: `M960 S5 P0 \n`,
                                    sequence_id: '0',
                                },
                            };
                        }
                        break;
                    case 'pause':
                        msg = {
                            print: {
                                sequence_id: '0',
                                command: 'pause',
                            },
                        };
                        break;
                    case 'updateHMSErrorCodeTranslation':
                        await this.loadHMSErrorCodeTranslations();
                        break;
                    case 'stop':
                        msg = {
                            print: {
                                sequence_id: '0',
                                command: 'stop',
                            },
                        };
                        break;
                    case 'resume':
                        msg = {
                            print: {
                                sequence_id: '0',
                                command: 'resume',
                            },
                        };
                        break;
                    case 'fanSpeedChamber':
                        // Legacy-State-Name (P1/X1); aktuelle States heißen big_fan2_speed
                        msg = {
                            print: {
                                command: 'gcode_line',
                                param: `M106 P3 S${state.val * 2.55} \n`,
                                sequence_id: '0',
                            },
                        };
                        break;
                    case 'heatbreak_fan_speed':
                        msg = {
                            print: {
                                command: 'gcode_line',
                                param: `M106 P4 S${state.val * 2.55} \n`,
                                sequence_id: '0',
                            },
                        };
                        break;
                    case 'spd_lvl':
                        msg = {
                            print: {
                                command: 'print_speed',
                                param: `${state.val} \n`,
                                sequence_id: '0',
                            },
                        };
                        break;
                    case 'bed_target_temper':
                        msg = {
                            print: {
                                command: 'gcode_line',
                                param: `M140 S${state.val} \n`,
                                sequence_id: '0',
                            },
                        };
                        break;
                    case 'nozzle_target_temper':
                        msg = {
                            print: {
                                command: 'gcode_line',
                                param: `M104 S${state.val} \n`,
                                sequence_id: '0',
                            },
                        };
                        break;
                    case 'big_fan1_speed':
                        msg = {
                            print: {
                                command: 'gcode_line',
                                param: `M106 P2 S${state.val * 2.55} \n`,
                                sequence_id: '0',
                            },
                        };
                        break;
                    case 'big_fan2_speed':
                        msg = {
                            print: {
                                command: 'gcode_line',
                                param: `M106 P3 S${state.val * 2.55} \n`,
                                sequence_id: '0',
                            },
                        };
                        break;
                    case 'cooling_fan_speed':
                        msg = {
                            print: {
                                command: 'gcode_line',
                                param: `M106 P1 S${state.val * 2.55} \n`,
                                sequence_id: '0',
                            },
                        };
                        break;
                    case 'homing':
                        // Block homing (G28) command during active printing/working state
                        if (this.isPrintingOrActiveState()) {
                            this.log.warn(
                                `Blocked homing command (G28) during active printing/working state (stg_cur: ${currentPrintingState}). Command ignored for safety.`,
                            );
                            return; // Exit without sending the command
                        }

                        msg = msg = {
                            print: {
                                command: 'gcode_line',
                                param: 'G28 \n',
                                reason: 'SUCCESS',
                                result: 'SUCCESS',
                                sequence_id: '20086',
                            },
                        };
                        break;
                }

                if (msg) {
                    this.publishMQTTmessages(msg);
                }
            }
        } else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter configuration options
     */
    module.exports = options => new Bambulab(options);
} else {
    // otherwise start the instance directly
    new Bambulab();
}
