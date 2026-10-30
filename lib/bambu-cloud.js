'use strict';

/**
 * Bambu Lab Cloud (Login + MQTT-Broker-Parameter).
 *
 * Warum diese Datei?
 * - LAN: Drucker-IP + LAN-Token (wie bisher).
 * - Cloud: Bambu-Account → Access-Token → MQTT bei us.mqtt.bambulab.com (ohne "Nur LAN" am Drucker).
 *
 * Orientierung: Home-Assistant-Integration (pybambu) und OpenBambuAPI – inoffizielle API, kann sich ändern.
 */

const { default: axios } = require('axios');

/** API-Endpunkte (Global; China nutzt andere Hosts – siehe cloudRegion). */
const URLS = {
    global: {
        login: 'https://api.bambulab.com/v1/user-service/user/login',
        preference: 'https://api.bambulab.com/v1/design-user-service/my/preference',
        mqttHost: 'us.mqtt.bambulab.com',
    },
    china: {
        login: 'https://api.bambulab.cn/v1/user-service/user/login',
        preference: 'https://api.bambulab.cn/v1/design-user-service/my/preference',
        mqttHost: 'cn.mqtt.bambulab.com',
    },
};

/** Header wie Bambu Studio/Orca – sonst blockiert die API Anfragen oft. */
function slicerHeaders() {
    return {
        'User-Agent': 'bambu_network_agent/01.09.05.01',
        'X-BBL-Client-Name': 'OrcaSlicer',
        'X-BBL-Client-Type': 'slicer',
        'X-BBL-Client-Version': '01.09.05.51',
        'X-BBL-Language': 'en-US',
        accept: 'application/json',
        'Content-Type': 'application/json',
    };
}

function regionKey(region) {
    return region === 'china' ? 'china' : 'global';
}

/**
 * Fehler mit verständlicher Meldung für das ioBroker-Log.
 */
class BambuCloudAuthError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'BambuCloudAuthError';
        this.code = code;
    }
}

/**
 * Login mit E-Mail + Passwort. Liefert accessToken (JWT).
 * 2FA / E-Mail-Code: wir werfen einen klaren Fehler – später erweiterbar.
 */
async function loginWithPassword(email, password, region = 'global') {
    const urls = URLS[regionKey(region)];
    const body = { account: email, password, apiError: '' };

    let response;
    try {
        response = await axios.post(urls.login, body, {
            headers: slicerHeaders(),
            timeout: 30000,
            validateStatus: status => status < 500,
        });
    } catch (err) {
        throw new BambuCloudAuthError(`Cloud-Login Netzwerkfehler: ${err.message}`, 'network');
    }

    const data = response.data || {};

    if (data.accessToken) {
        return data.accessToken;
    }

    const loginType = data.loginType;
    if (loginType === 'verifyCode') {
        throw new BambuCloudAuthError(
            'Bambu verlangt einen E-Mail-/SMS-Code (verifyCode). Das ist in dieser Adapter-Version noch nicht in der UI – Token manuell eintragen oder 2FA/Login vereinfachen.',
            'verifyCode',
        );
    }
    if (loginType === 'tfa') {
        throw new BambuCloudAuthError(
            'Bambu verlangt Zwei-Faktor-Authentifizierung (2FA). Noch nicht implementiert – alternativ Access-Token manuell in „Cloud Access Token“ speichern.',
            'tfa',
        );
    }

    throw new BambuCloudAuthError(
        `Cloud-Login fehlgeschlagen (HTTP ${response.status}): ${JSON.stringify(data).substring(0, 200)}`,
        'login',
    );
}

/**
 * MQTT-User für Cloud: `u_<uid>` – aus JWT oder Preference-API.
 */
async function resolveCloudMqttUsername(accessToken, region = 'global') {
    const parts = accessToken.split('.');
    if (parts.length === 3) {
        try {
            let payload = parts[1];
            payload += '='.repeat((4 - (payload.length % 4)) % 4);
            const json = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
            if (json.username) {
                return json.username;
            }
        } catch {
            // Fallback: Preference-API
        }
    }

    const urls = URLS[regionKey(region)];
    const response = await axios.get(urls.preference, {
        headers: {
            ...slicerHeaders(),
            Authorization: `Bearer ${accessToken}`,
        },
        timeout: 30000,
    });

    const uid = response.data && response.data.uid;
    if (uid === undefined || uid === null) {
        throw new BambuCloudAuthError('Cloud: user id (uid) aus Preference-API nicht lesbar', 'uid');
    }
    return `u_${uid}`;
}

/**
 * Liefert alles für mqtt.connect() im Cloud-Modus.
 *
 * @param {object} config Adapter-native Konfiguration
 * @param {(level: string, msg: string) => void} log
 */
async function buildCloudMqttConnect(config, log) {
    const region = config.cloudRegion || 'global';
    let accessToken = (config.cloudAccessToken || '').trim();

    if (!accessToken) {
        const email = (config.cloudEmail || '').trim();
        const password = config.cloudPassword || '';
        if (!email || !password) {
            throw new BambuCloudAuthError(
                'Cloud-Modus: E-Mail + Passwort oder gespeichertes „Cloud Access Token“ nötig',
                'config',
            );
        }
        log('info', 'Cloud-Login bei Bambu (Passwort wird nicht geloggt)…');
        accessToken = await loginWithPassword(email, password, region);
        log('info', 'Cloud-Login erfolgreich – Access-Token erhalten');
    }

    const username = await resolveCloudMqttUsername(accessToken, region);
    const host = URLS[regionKey(region)].mqttHost;

    return {
        url: `mqtts://${host}:8883`,
        options: {
            username,
            password: accessToken,
            reconnectPeriod: 30,
            rejectUnauthorized: true,
        },
        accessToken,
    };
}

/**
 * LAN wie bisher: Drucker-IP + bblp + LAN-Token.
 */
function buildLanMqttConnect(config) {
    const host = (config.host || '').trim();
    if (!host) {
        throw new Error('LAN-Modus: Drucker-IP (host) fehlt');
    }
    return {
        url: `mqtts://${host}:8883`,
        options: {
            username: 'bblp',
            password: config.Password,
            reconnectPeriod: 30,
            rejectUnauthorized: false,
        },
    };
}

/**
 * Ein Einstieg für main.js – wählt LAN oder Cloud.
 */
async function buildMqttConnect(config, log) {
    const mode = config.connectionMode || 'lan';
    if (mode === 'cloud') {
        return buildCloudMqttConnect(config, log);
    }
    return buildLanMqttConnect(config);
}

module.exports = {
    BambuCloudAuthError,
    buildMqttConnect,
    buildCloudMqttConnect,
    buildLanMqttConnect,
    loginWithPassword,
};
