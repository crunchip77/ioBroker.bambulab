'use strict';

/**
 * Bambu Lab Cloud (Login + MQTT-Broker-Parameter).
 *
 * Warum diese Datei?
 * - LAN: Drucker-IP + LAN-Token am Gerät.
 * - Cloud: Bambu-Konto → Access-Token → MQTT (Drucker darf im normalen Cloud-Modus bleiben).
 *
 * Login-Wege (Cloud):
 * 1) Gespeichertes cloudAccessToken (JWT)
 * 2) E-Mail + Passwort (wenn du in der App ein Bambu-Passwort gesetzt hast)
 * 3) E-Mail + 6-stelliger Code (typisch bei Google/OAuth – ohne Bambu-Passwort)
 */

const { default: axios } = require('axios');

/** API-Endpunkte (Global vs. China). */
const URLS = {
    global: {
        login: 'https://api.bambulab.com/v1/user-service/user/login',
        emailCode: 'https://api.bambulab.com/v1/user-service/user/sendemail/code',
        preference: 'https://api.bambulab.com/v1/design-user-service/my/preference',
        mqttHost: 'us.mqtt.bambulab.com',
    },
    china: {
        login: 'https://api.bambulab.cn/v1/user-service/user/login',
        emailCode: 'https://api.bambulab.cn/v1/user-service/user/sendemail/code',
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

class BambuCloudAuthError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'BambuCloudAuthError';
        this.code = code;
    }
}

async function postJson(url, body, validate400 = false) {
    const response = await axios.post(url, body, {
        headers: slicerHeaders(),
        timeout: 30000,
        validateStatus: status => (validate400 ? status < 500 : status < 500),
    });
    return response;
}

/**
 * Bambu schickt einen 6-stelligen Code an die Konto-E-Mail (Login ohne Passwort).
 */
async function requestEmailLoginCode(email, region = 'global') {
    const urls = URLS[regionKey(region)];
    const body = { email, type: 'codeLogin' };
    try {
        await postJson(urls.emailCode, body);
    } catch (err) {
        throw new BambuCloudAuthError(`E-Mail-Code anfordern fehlgeschlagen: ${err.message}`, 'network');
    }
}

/**
 * Login mit E-Mail + 6-stelligem Code (nach requestEmailLoginCode).
 */
async function loginWithEmailCode(email, code, region = 'global') {
    const urls = URLS[regionKey(region)];
    const body = { account: email, code: String(code).trim() };

    let response;
    try {
        response = await postJson(urls.login, body, true);
    } catch (err) {
        throw new BambuCloudAuthError(`Cloud-Login (Code) Netzwerkfehler: ${err.message}`, 'network');
    }

    const data = response.data || {};
    if (response.status === 200 && data.accessToken) {
        return data.accessToken;
    }
    if (response.status === 400 && data.code === 2) {
        throw new BambuCloudAuthError('E-Mail-Code falsch – bitte prüfen und erneut eintragen.', 'codeIncorrect');
    }
    if (response.status === 400 && data.code === 1) {
        throw new BambuCloudAuthError('E-Mail-Code abgelaufen – Adapter neu starten, neuen Code anfordern.', 'codeExpired');
    }

    throw new BambuCloudAuthError(
        `Cloud-Login (Code) fehlgeschlagen (HTTP ${response.status}): ${JSON.stringify(data).substring(0, 200)}`,
        'login',
    );
}

/**
 * Login mit E-Mail + Passwort (nur wenn du in der Bambu-App ein Passwort gesetzt hast).
 */
async function loginWithPassword(email, password, region = 'global') {
    const urls = URLS[regionKey(region)];
    const body = { account: email, password, apiError: '' };

    let response;
    try {
        response = await postJson(urls.login, body);
    } catch (err) {
        throw new BambuCloudAuthError(`Cloud-Login Netzwerkfehler: ${err.message}`, 'network');
    }

    const data = response.data || {};

    if (data.accessToken) {
        return data.accessToken;
    }

    const loginType = data.loginType;
    if (loginType === 'verifyCode') {
        await requestEmailLoginCode(email, region);
        throw new BambuCloudAuthError(
            'Bambu verlangt E-Mail-Code: Code wurde angefordert. Trage ihn unter „Cloud E-Mail verification code“ ein, speichern, Adapter neu starten.',
            'verifyCodeSent',
        );
    }
    if (loginType === 'tfa') {
        throw new BambuCloudAuthError(
            'Bambu verlangt 2FA – noch nicht implementiert. Nutze E-Mail-Code-Login oder „Cloud access token“.',
            'tfa',
        );
    }

    throw new BambuCloudAuthError(
        `Cloud-Login fehlgeschlagen (HTTP ${response.status}): ${JSON.stringify(data).substring(0, 200)}`,
        'login',
    );
}

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
            // Preference-API
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
 * Cloud-MQTT-Verbindung vorbereiten (Login + Broker-URL).
 */
async function buildCloudMqttConnect(config, log) {
    const region = config.cloudRegion || 'global';
    const email = (config.cloudEmail || '').trim();
    const loginMethod = config.cloudLoginMethod || 'emailCode';
    let accessToken = (config.cloudAccessToken || '').trim();
    const verifyCode = (config.cloudVerifyCode || '').trim();

    if (!accessToken) {
        if (!email) {
            throw new BambuCloudAuthError('Cloud: Bambu-E-Mail (cloudEmail) fehlt', 'config');
        }

        if (verifyCode) {
            log('info', 'Cloud-Login mit E-Mail-Bestätigungscode…');
            accessToken = await loginWithEmailCode(email, verifyCode, region);
            log('info', 'Cloud-Login (E-Mail-Code) erfolgreich');
        } else if (loginMethod === 'password') {
            const password = config.cloudPassword || '';
            if (!password) {
                throw new BambuCloudAuthError(
                    'Cloud Login-Methode „Passwort“: Bambu-Passwort fehlt (in App unter Kontosicherheit setzen, nicht Google-Passwort).',
                    'config',
                );
            }
            log('info', 'Cloud-Login bei Bambu (Passwort wird nicht geloggt)…');
            try {
                accessToken = await loginWithPassword(email, password, region);
            } catch (err) {
                if (err instanceof BambuCloudAuthError && err.code === 'verifyCodeSent') {
                    log('warn', err.message);
                }
                throw err;
            }
            log('info', 'Cloud-Login (Passwort) erfolgreich');
        } else {
            // emailCode: Standard für Google/OAuth – kein Passwort nötig
            log('info', `Fordere Bambu E-Mail-Logincode für ${email} an…`);
            await requestEmailLoginCode(email, region);
            throw new BambuCloudAuthError(
                'E-Mail mit 6-stelligem Code wurde angefordert. Code unter „Cloud E-Mail verification code“ eintragen, speichern, bambulab.0 neu starten. Code-Feld danach leer lassen oder löschen.',
                'verifyCodeSent',
            );
        }
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
    loginWithEmailCode,
    requestEmailLoginCode,
};
