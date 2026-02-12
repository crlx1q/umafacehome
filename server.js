const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const os = require('os');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const PORT = 3000;

// Пароль для админ-панели
const ADMIN_PASSWORD = '651956';

// OpenWeatherMap настройки
const WEATHER_API_KEY = '4cd5683e0f0deab9f076f289b65e6d53';
const WEATHER_CITY = 'Kokshetau';
const WEATHER_UPDATE_INTERVAL = 30 * 60 * 1000; // 30 минут

const CONFIG_FILE = path.join(__dirname, 'runtime-config.json');

let runtimeConfig = {
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    geminiModel: 'gemini-2.5-flash-lite',
    smartthingsToken: process.env.SMARTTHINGS_TOKEN || '',
    musicStreamUrl: 'https://cast.joystream.nl:80/radio538',
    musicStationName: 'Internet Radio'
};

let genAI = null;

function initGeminiClient() {
    const key = runtimeConfig.geminiApiKey;
    if (!key) {
        genAI = null;
        return;
    }
    try {
        genAI = new GoogleGenerativeAI(key);
        console.log('✓ Gemini API ключ загружен');
    } catch (error) {
        genAI = null;
        console.error('✗ Ошибка инициализации Gemini API:', error.message);
    }
}

// --- ХРАНИЛИЩЕ СОСТОЯНИЯ (В ОЗУ) ---
let globalState = {
    // Режим экрана: 'idle', 'weather', 'smarthome', 'clock', 'text', 'vibe'
    mode: 'idle', 
    
    // Текущая эмоция: 'normal', 'blink', 'wink', 'yawn', 'dizzy'
    emotion: 'normal',
    
    // Данные для отображения
    weather: { temp: '-12', condition: 'snow', city: 'Zerenda' }, 
    smartHome: { device: 'Лампа Спальня', status: 'off' },        
    aiText: "Я обновился! Теперь у меня старое лицо, но новые возможности.",
    // Таймер (total/left в секундах)
    timer: { total: 0, left: 0 },
    // Музыка (отображение обложки/названия)
    music: { title: '', artist: '', progressPercent: 0, streamUrl: '' },
    // Vibe (фоторамка) - текущее изображение
    vibe: { currentImage: 1 },
    // Блокировка устройств
    deviceLocked: false,
    smartThings: { devices: [] },
    
    lastUpdate: Date.now()
};

// --- ТРЕКИНГ ПОДКЛЮЧЕННЫХ УСТРОЙСТВ ---
let connectedDevices = {}; // { ip: { ip, name, battery, charging, lastSeen, locked } }
let adminPanelOpen = false;
const DEVICE_TIMEOUT = 30000; // 30 секунд без запросов = неактивное устройство

// Функция получения IP адреса из запроса
function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }
    return req.connection.remoteAddress || req.socket.remoteAddress || 'unknown';
}

// Функция очистки неактивных устройств
function cleanupInactiveDevices() {
    const now = Date.now();
    for (const ip in connectedDevices) {
        if (now - connectedDevices[ip].lastSeen > DEVICE_TIMEOUT) {
            delete connectedDevices[ip];
        }
    }
}

function loadRuntimeConfig() {
    if (!fs.existsSync(CONFIG_FILE)) return;
    try {
        const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        runtimeConfig = Object.assign(runtimeConfig, data || {});
    } catch (error) {
        console.error('✗ Ошибка загрузки runtime-config.json:', error.message);
    }
}

function saveRuntimeConfig() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(runtimeConfig, null, 2), 'utf8');
}

function sendJson(res, code, payload) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(payload));
}

function httpsRequestJson(method, requestUrl, headers, body) {
    return new Promise((resolve, reject) => {
        const options = new URL(requestUrl);
        options.method = method;
        options.headers = headers || {};
        const req = https.request(options, (resp) => {
            let data = '';
            resp.on('data', (chunk) => data += chunk);
            resp.on('end', () => {
                try {
                    const parsed = data ? JSON.parse(data) : {};
                    if (resp.statusCode >= 200 && resp.statusCode < 300) resolve(parsed);
                    else reject(new Error((parsed.message || parsed.error || data || 'HTTP ' + resp.statusCode).toString()));
                } catch (e) {
                    if (resp.statusCode >= 200 && resp.statusCode < 300) resolve({ raw: data });
                    else reject(new Error(data || 'HTTP ' + resp.statusCode));
                }
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

async function fetchSmartThingsDevices() {
    if (!runtimeConfig.smartthingsToken) return [];
    const headers = { Authorization: 'Bearer ' + runtimeConfig.smartthingsToken };
    const list = await httpsRequestJson('GET', 'https://api.smartthings.com/v1/devices', headers);
    const items = (list.items || []).slice(0, 20);
    const result = [];
    for (const d of items) {
        try {
            const st = await httpsRequestJson('GET', 'https://api.smartthings.com/v1/devices/' + d.deviceId + '/status', headers);
            const sw = st.components && st.components.main && st.components.main.switch && st.components.main.switch.switch && st.components.main.switch.switch.value;
            result.push({
                id: d.deviceId,
                name: d.label || d.name,
                status: sw === 'on' ? 'on' : 'off',
                capability: sw ? 'switch' : 'status',
                raw: st.components && st.components.main ? st.components.main : {}
            });
        } catch (e) {
            result.push({ id: d.deviceId, name: d.label || d.name, status: 'unknown', capability: 'status', raw: {} });
        }
    }
    globalState.smartThings = { devices: result };
    globalState.smartHome = { devices: result };
    return result;
}

async function sendSmartThingsCommand(deviceId, command) {
    const headers = { Authorization: 'Bearer ' + runtimeConfig.smartthingsToken, 'Content-Type': 'application/json' };
    const payload = JSON.stringify({ commands: [{ component: 'main', capability: 'switch', command: command, arguments: [] }] });
    await httpsRequestJson('POST', 'https://api.smartthings.com/v1/devices/' + deviceId + '/commands', headers, payload);
}

async function updateRadioMetadata() {
    const stream = runtimeConfig.musicStreamUrl;
    if (!stream) return;
    const req = https.request(stream, { headers: { 'Icy-MetaData': '1', 'User-Agent': 'UmaAI/1.0' } }, (resp) => {
        const metaint = parseInt(resp.headers['icy-metaint'], 10);
        if (!metaint || !resp.headers['content-type']) { resp.destroy(); return; }
        let total = 0;
        let metadataLen = -1;
        let meta = Buffer.alloc(0);
        resp.on('data', (chunk) => {
            for (let i=0;i<chunk.length;i++) {
                total++;
                if (metadataLen < 0 && total === metaint + 1) {
                    metadataLen = chunk[i] * 16;
                    continue;
                }
                if (metadataLen >= 0 && meta.length < metadataLen) {
                    meta = Buffer.concat([meta, Buffer.from([chunk[i]])]);
                    if (meta.length >= metadataLen) {
                        const str = meta.toString('utf8').replace(/\0/g, '');
                        const m = str.match(/StreamTitle='([^']*)'/);
                        if (m && m[1]) {
                            const parts = m[1].split(' - ');
                            globalState.music.title = parts[1] || parts[0];
                            globalState.music.artist = parts[1] ? parts[0] : runtimeConfig.musicStationName;
                            globalState.music.streamUrl = runtimeConfig.musicStreamUrl;
                            globalState.music.progressPercent = 30;
                            globalState.lastUpdate = Date.now();
                        }
                        resp.destroy();
                        return;
                    }
                }
            }
        });
    });
    req.on('error', () => {});
    req.end();
}

loadRuntimeConfig();
initGeminiClient();
setInterval(() => { updateRadioMetadata(); }, 45000);
updateRadioMetadata();

// --- ФУНКЦИЯ ОБНОВЛЕНИЯ ПОГОДЫ ---
function updateWeather() {
    const apiUrl = `https://api.openweathermap.org/data/2.5/weather?q=${WEATHER_CITY}&appid=${WEATHER_API_KEY}&units=metric&lang=ru`;
    const forecastUrl = `https://api.openweathermap.org/data/2.5/forecast?q=${WEATHER_CITY}&appid=${WEATHER_API_KEY}&units=metric&lang=ru&cnt=6`;
    
    // Получаем текущую погоду
    https.get(apiUrl, (response) => {
        let data = '';
        
        response.on('data', (chunk) => {
            data += chunk;
        });
        
        response.on('end', () => {
            try {
                const weatherData = JSON.parse(data);
                
                if (weatherData.main && weatherData.weather && weatherData.weather.length > 0) {
                    const temp = Math.round(weatherData.main.temp);
                    const weatherId = weatherData.weather[0].id;
                    const description = weatherData.weather[0].description;
                    
                    // Определяем условие погоды по коду OpenWeatherMap
                    let condition = 'clear';
                    if (weatherId >= 200 && weatherId < 300) {
                        condition = 'storm'; // Гроза
                    } else if (weatherId >= 300 && weatherId < 600) {
                        condition = 'rain'; // Дождь/морось
                    } else if (weatherId >= 600 && weatherId < 700) {
                        condition = 'snow'; // Снег
                    } else if (weatherId >= 700 && weatherId < 800) {
                        condition = 'fog'; // Туман/дымка
                    } else if (weatherId === 800) {
                        condition = 'clear'; // Ясно
                    } else if (weatherId > 800) {
                        condition = 'clouds'; // Облачно
                    }
                    
                    // Сохраняем текущую погоду
                    globalState.weather = {
                        temp: temp > 0 ? `+${temp}` : `${temp}`,
                        condition: condition,
                        city: WEATHER_CITY,
                        forecast: globalState.weather ? globalState.weather.forecast : [] // Сохраняем старый прогноз, если есть
                    };
                    
                    // Получаем прогноз
                    https.get(forecastUrl, (forecastResponse) => {
                        let forecastData = '';
                        
                        forecastResponse.on('data', (chunk) => {
                            forecastData += chunk;
                        });
                        
                        forecastResponse.on('end', () => {
                            try {
                                const forecastJson = JSON.parse(forecastData);
                                
                                if (forecastJson.list && Array.isArray(forecastJson.list)) {
                                    const forecast = [];
                                    const now = new Date();
                                    
                                    // Берем ближайшие 6 прогнозов (примерно на 18 часов вперед)
                                    for (let i = 0; i < Math.min(6, forecastJson.list.length); i++) {
                                        const item = forecastJson.list[i];
                                        const forecastTime = new Date(item.dt * 1000);
                                        const hours = forecastTime.getHours();
                                        const minutes = forecastTime.getMinutes();
                                        const timeStr = (hours < 10 ? '0' + hours : hours) + ':' + (minutes < 10 ? '0' + minutes : minutes);
                                        
                                        const forecastTemp = Math.round(item.main.temp);
                                        
                                        forecast.push({
                                            time: timeStr,
                                            temp: forecastTemp > 0 ? `+${forecastTemp}` : `${forecastTemp}`,
                                            condition: item.weather && item.weather[0] ? item.weather[0].main.toLowerCase() : 'clear'
                                        });
                                    }
                                    
                                    globalState.weather.forecast = forecast;
                                    console.log(`✓ Прогноз обновлен: ${forecast.length} часов`);
                                }
                            } catch (error) {
                                console.error('✗ Ошибка парсинга прогноза:', error.message);
                            }
                        });
                    }).on('error', (error) => {
                        console.error('✗ Ошибка получения прогноза:', error.message);
                    });
                    
                    globalState.lastUpdate = Date.now();
                    console.log(`✓ Погода обновлена: ${globalState.weather.temp}°C, ${description}, ${WEATHER_CITY}`);
                } else {
                    console.error('✗ Ошибка: неверный формат данных от OpenWeatherMap');
                }
            } catch (error) {
                console.error('✗ Ошибка парсинга данных погоды:', error.message);
            }
        });
    }).on('error', (error) => {
        console.error('✗ Ошибка получения погоды:', error.message);
    });
}

// Обновляем погоду при запуске
updateWeather();

// Обновляем погоду каждые 10 минут
setInterval(() => {
    updateWeather();
}, WEATHER_UPDATE_INTERVAL);

// --- ФОН: ОБНОВЛЕНИЕ ТАЙМЕРА ---
setInterval(() => {
    if (globalState.timer && globalState.timer.left > 0) {
        globalState.timer.left -= 1;
        if (globalState.timer.left < 0) globalState.timer.left = 0;
        globalState.lastUpdate = Date.now();
    }
}, 1000);

// --- ФОН: ОЧИСТКА НЕАКТИВНЫХ УСТРОЙСТВ ---
setInterval(() => {
    cleanupInactiveDevices();
}, 10000); // Каждые 10 секунд

// --- ФОН: ПРОВЕРКА АДМИН-ПАНЕЛИ (таймаут 5 секунд без heartbeat) ---
setInterval(() => {
    // Если админ-панель не отправляла heartbeat более 5 секунд, считаем её закрытой
    // Это будет обновляться через heartbeat endpoint
}, 5000);

// --- ФОН: ЗАПРОС БАТАРЕИ У УСТРОЙСТВ (только если админ-панель открыта) ---
let batteryRequestInterval = null;

function startBatteryRequests() {
    if (batteryRequestInterval) return; // Уже запущен
    
    batteryRequestInterval = setInterval(() => {
        if (!adminPanelOpen) {
            if (batteryRequestInterval) {
                clearInterval(batteryRequestInterval);
                batteryRequestInterval = null;
            }
            return;
        }
        
        // Запросы батареи будут делаться через админ-панель напрямую
        // Здесь только проверяем флаг
    }, 5000);
}

// Проверяем флаг админ-панели каждые 2 секунды
setInterval(() => {
    if (adminPanelOpen && !batteryRequestInterval) {
        startBatteryRequests();
    } else if (!adminPanelOpen && batteryRequestInterval) {
        clearInterval(batteryRequestInterval);
        batteryRequestInterval = null;
    }
}, 2000);

const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // 1. Отдача файлов (теперь отдаем index NEW.html как главный, если переименуете)
    // Но здесь я ищу именно файлы с приставкой NEW, как вы и просили
    if (pathname === '/' || pathname === '/index.html') {
        serveFile(res, 'index NEW.html', 'text/html');
    } 
    else if (pathname === '/admin' || pathname === '/admin.html') {
        // Проверка пароля для админ-панели
        const query = parsedUrl.query;
        const password = query.password;
        
        if (password !== ADMIN_PASSWORD) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(getLoginPage());
            return;
        }
        
        serveFile(res, 'admin NEW.html', 'text/html');
    }

    // 2. API для ТЕЛЕФОНА
    else if (pathname === '/api/poll') {
        const clientIp = getClientIp(req);
        const now = Date.now();
        
        // Обновляем информацию об устройстве
        if (!connectedDevices[clientIp]) {
            connectedDevices[clientIp] = {
                ip: clientIp,
                name: clientIp,
                battery: null,
                charging: false,
                lastSeen: now,
                locked: false
            };
        } else {
            connectedDevices[clientIp].lastSeen = now;
            // Обновляем блокировку из globalState
            connectedDevices[clientIp].locked = globalState.deviceLocked || false;
        }
        
        res.writeHead(200, { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*' 
        });
        res.end(JSON.stringify(globalState));
    }

    // 3. API для ГОЛОСОВОГО ВВОДА
    else if (pathname === '/api/voice' && req.method === 'POST') {
        handleVoiceRequest(req, res);
    }

    // 4. API для VIBE - список изображений
    else if (pathname === '/api/vibe/list') {
        getVibeImageList(res);
    }
    
    // 4.1. API для VIBE - удаление изображения
    else if (pathname === '/api/vibe/delete' && req.method === 'GET') {
        handleVibeDelete(req, res, parsedUrl);
    }
    
    // 4.2. API для VIBE - загрузка изображения
    else if (pathname === '/api/vibe/upload' && req.method === 'POST') {
        handleVibeUpload(req, res);
    }
    
    // 5. Раздача файлов из папки photos/
    else if (pathname.startsWith('/photos/')) {
        servePhotoFile(res, pathname);
    }

    // 5.6 Runtime config
    else if (pathname === '/api/config' && req.method === 'GET') {
        sendJson(res, 200, runtimeConfig);
    }
    else if (pathname === '/api/config' && req.method === 'POST') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            try {
                const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
                runtimeConfig.geminiApiKey = (payload.geminiApiKey || runtimeConfig.geminiApiKey || '').trim();
                runtimeConfig.geminiModel = (payload.geminiModel || runtimeConfig.geminiModel || 'gemini-2.5-flash-lite').trim();
                runtimeConfig.smartthingsToken = (payload.smartthingsToken || runtimeConfig.smartthingsToken || '').trim();
                runtimeConfig.musicStreamUrl = (payload.musicStreamUrl || runtimeConfig.musicStreamUrl || '').trim();
                runtimeConfig.musicStationName = (payload.musicStationName || runtimeConfig.musicStationName || 'Internet Radio').trim();
                saveRuntimeConfig();
                initGeminiClient();
                sendJson(res, 200, { success: true, config: runtimeConfig });
            } catch (error) {
                sendJson(res, 400, { error: error.message });
            }
        });
    }
    else if (pathname === '/api/gemini/models' && req.method === 'GET') {
        const key = runtimeConfig.geminiApiKey;
        if (!key) { sendJson(res, 400, { error: 'Gemini API key is empty' }); return; }
        httpsRequestJson('GET', 'https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(key), {}, null)
            .then((data) => {
                const models = (data.models || []).map((m) => m.name.replace('models/', '')).filter((n) => n.indexOf('gemini') !== -1);
                sendJson(res, 200, { models: models });
            })
            .catch((error) => sendJson(res, 500, { error: error.message }));
    }
    else if (pathname === '/api/smartthings/devices' && req.method === 'GET') {
        fetchSmartThingsDevices().then((devices) => sendJson(res, 200, { devices: devices })).catch((error) => sendJson(res, 500, { error: error.message }));
    }
    else if (pathname === '/api/smartthings/device/control' && req.method === 'POST') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            try {
                const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
                const deviceId = payload.deviceId;
                const command = payload.command === 'off' ? 'off' : 'on';
                sendSmartThingsCommand(deviceId, command)
                    .then(() => fetchSmartThingsDevices())
                    .then(() => sendJson(res, 200, { success: true }))
                    .catch((error) => sendJson(res, 500, { error: error.message }));
            } catch (error) {
                sendJson(res, 400, { error: error.message });
            }
        });
    }

    // 6. API для АДМИНКИ
    else if (pathname === '/api/set') {
        const query = parsedUrl.query;
        
        if (query.mode) globalState.mode = query.mode;
        if (query.emotion) globalState.emotion = query.emotion;
        
        if (query.text) globalState.aiText = query.text;
        if (query.deviceState) globalState.smartHome.status = query.deviceState;

        // Таймер: timerTotal в секундах, при 0 — сброс
        if (typeof query.timerTotal !== 'undefined') {
            const total = parseInt(query.timerTotal, 10) || 0;
            if (!globalState.timer) globalState.timer = { total: 0, left: 0 };
            globalState.timer.total = total;
            globalState.timer.left = total;
        }
        // Явная остановка таймера
        if (typeof query.timerStop !== 'undefined') {
            if (!globalState.timer) globalState.timer = { total: 0, left: 0 };
            globalState.timer.total = 0;
            globalState.timer.left = 0;
        }

        // Музыка: простое демо-управление
        if (query.musicTitle || query.musicArtist || query.musicProgress) {
            if (!globalState.music) globalState.music = { title: '', artist: '', progressPercent: 0 };
            if (query.musicTitle) globalState.music.title = query.musicTitle;
            if (query.musicArtist) globalState.music.artist = query.musicArtist;
            if (query.musicStreamUrl) runtimeConfig.musicStreamUrl = query.musicStreamUrl;
            globalState.music.streamUrl = runtimeConfig.musicStreamUrl;
            if (typeof query.musicProgress !== 'undefined') {
                let p = parseInt(query.musicProgress, 10);
                if (isNaN(p)) p = 0;
                if (p < 0) p = 0;
                if (p > 100) p = 100;
                globalState.music.progressPercent = p;
            }
        }
        
        globalState.lastUpdate = Date.now();
        
        // Авто-сброс эмоций
        if (['wink', 'yawn', 'dizzy'].includes(query.emotion)) {
            setTimeout(() => {
                globalState.emotion = 'normal';
                globalState.lastUpdate = Date.now();
            }, 3000);
        }

        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ status: 'ok', currentState: globalState }));
    }
    
    else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

// Функция генерации страницы входа
function getLoginPage() {
    return `
        <!DOCTYPE html>
        <html lang="ru">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>UmaAI Admin - Авторизация</title>
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
            <style>
                body {
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    background: linear-gradient(135deg, #0f0519 0%, #1a0d2e 50%, #2d1b4e 100%);
                    color: #f3f4f6;
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    margin: 0;
                }
                .login-container {
                    background: rgba(45, 27, 78, 0.4);
                    backdrop-filter: blur(10px);
                    border: 1px solid rgba(139, 92, 246, 0.2);
                    border-radius: 20px;
                    padding: 2rem;
                    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
                    text-align: center;
                    max-width: 400px;
                    width: 90%;
                }
                h1 {
                    color: #a78bfa;
                    margin-bottom: 1rem;
                    font-size: 1.8rem;
                }
                p {
                    color: #d1d5db;
                    margin-bottom: 1.5rem;
                }
                input {
                    width: 100%;
                    padding: 1rem;
                    background: rgba(26, 13, 46, 0.6);
                    border: 1px solid rgba(139, 92, 246, 0.2);
                    border-radius: 12px;
                    color: #f3f4f6;
                    font-size: 1rem;
                    margin: 1rem 0;
                    box-sizing: border-box;
                    font-family: inherit;
                }
                input:focus {
                    outline: none;
                    border-color: #8b5cf6;
                    box-shadow: 0 0 0 3px rgba(139, 92, 246, 0.1);
                }
                input::placeholder {
                    color: #9ca3af;
                }
                button {
                    width: 100%;
                    padding: 1rem;
                    background: linear-gradient(135deg, #8b5cf6 0%, #6b46c1 100%);
                    border: none;
                    border-radius: 12px;
                    color: white;
                    font-size: 1rem;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.3s ease;
                    font-family: inherit;
                }
                button:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 8px 24px rgba(139, 92, 246, 0.4);
                }
                button:active {
                    transform: translateY(0);
                }
                .error {
                    color: #ef4444;
                    margin-top: 1rem;
                    display: none;
                    font-size: 0.9rem;
                }
                .error.show {
                    display: block;
                }
            </style>
        </head>
        <body>
            <div class="login-container">
                <h1><i class="fas fa-robot"></i> UmaAI Control</h1>
                <p>Введите пароль для доступа к панели управления</p>
                <form onsubmit="checkPassword(event)">
                    <input type="password" id="password" placeholder="Пароль" autofocus autocomplete="off">
                    <button type="submit"><i class="fas fa-lock"></i> Войти</button>
                </form>
                <div class="error" id="error">Неверный пароль</div>
            </div>
            <script>
                function checkPassword(e) {
                    e.preventDefault();
                    const password = document.getElementById('password').value;
                    const errorDiv = document.getElementById('error');
                    
                    if (!password) {
                        return;
                    }
                    
                    window.location.href = '/admin?password=' + encodeURIComponent(password);
                }
                
                // Автофокус на поле ввода
                document.getElementById('password').focus();
            </script>
        </body>
        </html>
    `;
}

function serveFile(res, fileName, contentType) {
    // Ищем файл в текущей папке
    const filePath = path.join(__dirname, fileName);
    fs.readFile(filePath, (err, content) => {
        if (err) {
            // Если файл NEW не найден, попробуем без NEW (для обратной совместимости)
            const fallback = fileName.replace(' NEW', '');
            fs.readFile(path.join(__dirname, fallback), (err2, content2) => {
                if (err2) {
                    res.writeHead(500);
                    res.end('Error loading ' + fileName);
                } else {
                    res.writeHead(200, { 'Content-Type': contentType + '; charset=utf-8' });
                    res.end(content2, 'utf-8');
                }
            });
        } else {
            res.writeHead(200, { 'Content-Type': contentType + '; charset=utf-8' });
            res.end(content, 'utf-8');
        }
    });
}

// --- VIBE: Получение списка изображений ---
function getVibeImageList(res) {
    const photosDir = path.join(__dirname, 'photos');
    const extensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const maxImages = 10;
    const images = [];
    
    // Проверяем существование папки
    if (!fs.existsSync(photosDir)) {
        res.writeHead(200, { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*' 
        });
        res.end(JSON.stringify({ images: [], count: 0 }));
        return;
    }
    
    // Ищем файлы 1.jpg, 2.png, 3.gif и т.д.
    for (let i = 1; i <= maxImages; i++) {
        for (const ext of extensions) {
            const fileName = i + ext;
            const filePath = path.join(photosDir, fileName);
            if (fs.existsSync(filePath)) {
                images.push({
                    index: i,
                    filename: fileName,
                    url: '/photos/' + fileName
                });
                break; // Нашли файл с этим номером, переходим к следующему
            }
        }
    }
    
    res.writeHead(200, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*' 
    });
    res.end(JSON.stringify({ images: images, count: images.length }));
}

// --- VIBE: Раздача файлов из photos/ ---
function servePhotoFile(res, pathname) {
    // pathname: /photos/1.jpg -> photos/1.jpg
    const fileName = pathname.substring(8); // убираем "/photos/"
    const filePath = path.join(__dirname, 'photos', fileName);
    
    // Определяем content-type по расширению
    const ext = path.extname(fileName).toLowerCase();
    const mimeTypes = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp'
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    
    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(404);
            res.end('Image not found');
        } else {
            res.writeHead(200, { 
                'Content-Type': contentType,
                'Cache-Control': 'public, max-age=3600'
            });
            res.end(content);
        }
    });
}

// --- VIBE: Удаление изображения ---
function handleVibeDelete(req, res, parsedUrl) {
    const query = parsedUrl.query;
    const index = parseInt(query.index, 10);
    
    if (!index || index < 1 || index > 10) {
        res.writeHead(400, { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*' 
        });
        res.end(JSON.stringify({ error: 'Invalid index. Must be 1-10' }));
        return;
    }
    
    const photosDir = path.join(__dirname, 'photos');
    const extensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    let deleted = false;
    
    // Пытаемся удалить файл с любым расширением
    for (const ext of extensions) {
        const fileName = index + ext;
        const filePath = path.join(photosDir, fileName);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            deleted = true;
            break;
        }
    }
    
    res.writeHead(200, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*' 
    });
    res.end(JSON.stringify({ 
        success: true, 
        deleted: deleted,
        message: deleted ? `Image ${index} deleted` : `Image ${index} not found`
    }));
}

// --- VIBE: Загрузка изображения ---
function handleVibeUpload(req, res) {
    const chunks = [];
    let totalLength = 0;
    
    req.on('data', (chunk) => {
        chunks.push(chunk);
        totalLength += chunk.length;
    });
    
    req.on('end', () => {
        try {
            const buffer = Buffer.concat(chunks, totalLength);
            const boundary = req.headers['content-type']?.split('boundary=')[1];
            
            if (!boundary) {
                res.writeHead(400, { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*' 
                });
                res.end(JSON.stringify({ error: 'No boundary found' }));
                return;
            }
            
            const formData = parseMultipartFormData(buffer, boundary);
            
            if (!formData.image || !formData.index) {
                res.writeHead(400, { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*' 
                });
                res.end(JSON.stringify({ error: 'Missing image or index' }));
                return;
            }
            
            const index = parseInt(formData.index, 10);
            if (!index || index < 1 || index > 10) {
                res.writeHead(400, { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*' 
                });
                res.end(JSON.stringify({ error: 'Invalid index. Must be 1-10' }));
                return;
            }
            
            // Определяем расширение из оригинального имени файла или content-type
            let ext = '.jpg';
            if (formData.filename) {
                const fileExt = path.extname(formData.filename).toLowerCase();
                if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(fileExt)) {
                    ext = fileExt === '.jpeg' ? '.jpg' : fileExt;
                }
            } else if (formData.contentType) {
                const mimeToExt = {
                    'image/jpeg': '.jpg',
                    'image/png': '.png',
                    'image/gif': '.gif',
                    'image/webp': '.webp'
                };
                ext = mimeToExt[formData.contentType] || '.jpg';
            }
            
            const photosDir = path.join(__dirname, 'photos');
            if (!fs.existsSync(photosDir)) {
                fs.mkdirSync(photosDir, { recursive: true });
            }
            
            // Удаляем старый файл с этим индексом (если есть)
            const extensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
            for (const oldExt of extensions) {
                const oldFileName = index + oldExt;
                const oldFilePath = path.join(photosDir, oldFileName);
                if (fs.existsSync(oldFilePath)) {
                    fs.unlinkSync(oldFilePath);
                }
            }
            
            // Сохраняем новый файл
            const fileName = index + ext;
            const filePath = path.join(photosDir, fileName);
            fs.writeFileSync(filePath, formData.image);
            
            res.writeHead(200, { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*' 
            });
            res.end(JSON.stringify({ 
                success: true, 
                index: index,
                filename: fileName,
                url: '/photos/' + fileName
            }));
            
        } catch (error) {
            console.error('Upload error:', error);
            res.writeHead(500, { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*' 
            });
            res.end(JSON.stringify({ error: error.message }));
        }
    });
    
    req.on('error', (error) => {
        console.error('Request error:', error);
        res.writeHead(500, { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*' 
        });
        res.end(JSON.stringify({ error: 'Request error' }));
    });
}

// --- Парсинг multipart/form-data для загрузки файлов ---
function parseMultipartFormData(buffer, boundary) {
    const boundaryBuffer = Buffer.from('--' + boundary);
    const parts = [];
    let start = 0;
    
    while (true) {
        const boundaryIndex = buffer.indexOf(boundaryBuffer, start);
        if (boundaryIndex === -1) break;
        
        if (start > 0) {
            // Убираем \r\n перед boundary
            let partEnd = boundaryIndex;
            if (partEnd >= 2 && buffer[partEnd - 2] === 0x0D && buffer[partEnd - 1] === 0x0A) {
                partEnd -= 2;
            }
            const partData = buffer.slice(start, partEnd);
            if (partData.length > 0) {
                parts.push(partData);
            }
        }
        
        start = boundaryIndex + boundaryBuffer.length;
        // Пропускаем \r\n после boundary
        if (start < buffer.length && buffer[start] === 0x0D && buffer[start + 1] === 0x0A) {
            start += 2;
        }
    }
    
    const result = {};
    for (const part of parts) {
        const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
        if (headerEnd === -1) continue;
        
        const headers = part.slice(0, headerEnd).toString();
        const body = part.slice(headerEnd + 4);
        
        // Парсим заголовки
        const nameMatch = headers.match(/name=["']([^"']+)["']/);
        const filenameMatch = headers.match(/filename=["']([^"']+)["']/);
        const contentTypeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);
        
        if (nameMatch) {
            const fieldName = nameMatch[1];
            if (filenameMatch) {
                // Это файл
                result.image = body;
                result.filename = filenameMatch[1];
                if (contentTypeMatch) {
                    result.contentType = contentTypeMatch[1].trim();
                }
            } else {
                // Это обычное поле - убираем \r\n в конце
                let fieldValue = body;
                const fieldEnd = fieldValue.length;
                if (fieldEnd >= 2 && fieldValue[fieldEnd - 2] === 0x0D && fieldValue[fieldEnd - 1] === 0x0A) {
                    fieldValue = fieldValue.slice(0, fieldEnd - 2);
                }
                result[fieldName] = fieldValue.toString('utf-8').trim();
            }
        }
    }
    
    return result;
}

function handleVoiceRequest(req, res) {
    const chunks = [];
    let totalLength = 0;
    
    req.on('data', (chunk) => {
        chunks.push(chunk);
        totalLength += chunk.length;
    });
    
    req.on('end', async () => {
        try {
            const buffer = Buffer.concat(chunks, totalLength);
            
            // Парсим multipart/form-data вручную (простая реализация)
            const boundary = req.headers['content-type']?.split('boundary=')[1];
            if (!boundary) {
                res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: 'No boundary found' }));
                return;
            }
            
            const audioData = parseMultipart(buffer, boundary);
            
            if (!audioData || !audioData.audio) {
                res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: 'No audio file found' }));
                return;
            }

            // Сигнал телефону: файл получен, идёт обработка — показать "thinking"
            globalState.emotion = 'thinking';
            globalState.lastUpdate = Date.now();

            // Отправляем в Gemini API
            const textResponse = await processAudioWithGemini(audioData.audio);
            
            // Парсим команды из ответа
            const { cleanText, commands } = parseCommands(textResponse);
            
            // Сначала ВСЕГДА показываем текст ответа
            globalState.mode = 'text';
            globalState.aiText = cleanText;
            globalState.emotion = 'talking';
            globalState.lastUpdate = Date.now();
            
            // Если есть команды - выполняем через 2 секунды после показа текста
            if (commands.length > 0) {
                setTimeout(() => {
                    applyCommands(commands);
                    globalState.lastUpdate = Date.now();
                }, 2000);
            }
            
            res.writeHead(200, { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*' 
            });
            res.end(JSON.stringify({ text: textResponse }));
            
        } catch (error) {
            console.error('Voice request error:', error);
            globalState.emotion = 'normal'; // сбрасываем эмоцию, если произошла ошибка
            globalState.lastUpdate = Date.now();
            res.writeHead(500, { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*' 
            });
            res.end(JSON.stringify({ error: error.message }));
        }
    });
    
    req.on('error', (error) => {
        console.error('Request error:', error);
        res.writeHead(500, { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*' 
        });
        res.end(JSON.stringify({ error: 'Request error' }));
    });
}

function parseMultipart(buffer, boundary) {
    const boundaryBuffer = Buffer.from('--' + boundary);
    const parts = [];
    let start = 0;
    
    while (true) {
        const boundaryIndex = buffer.indexOf(boundaryBuffer, start);
        if (boundaryIndex === -1) break;
        
        if (start > 0) {
            // Это конец предыдущей части
            const partData = buffer.slice(start, boundaryIndex);
            parts.push(partData);
        }
        
        start = boundaryIndex + boundaryBuffer.length + 2; // +2 для \r\n
    }
    
    // Парсим части
    const result = {};
    for (const part of parts) {
        const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
        if (headerEnd === -1) continue;
        
        const headers = part.slice(0, headerEnd).toString();
        const body = part.slice(headerEnd + 4);
        
        // Ищем имя поля (поддерживаем и одинарные и двойные кавычки)
        const nameMatch = headers.match(/name=["']([^"']+)["']/);
        if (nameMatch && nameMatch[1] === 'audio') {
            result.audio = body;
        }
    }
    
    return result;
}

function parseCommands(text) {
    const commands = [];
    
    // Парсим команды вида {COMMAND: параметры} или {COMMAND}
    // Поддерживаем пробелы внутри скобок и любой регистр
    const commandRegex = /\{\s*([A-Za-z_]+)\s*(?::\s*([^}]+))?\s*\}/g;
    let match;
    
    while ((match = commandRegex.exec(text)) !== null) {
        // Нормализуем имя команды к верхнему регистру
        const commandName = match[1].toUpperCase();
        const commandParam = match[2] || '';
        
        commands.push({ name: commandName, param: commandParam.trim() });
    }
    
    // Удаляем ВСЕ команды из текста одним проходом
    let cleanText = text
        .replace(/\{\s*[A-Za-z_]+\s*(?::\s*[^}]+)?\s*\}/g, '') // Удаляем все команды
        .replace(/\s+/g, ' ')  // Множественные пробелы -> один
        .trim();
    
    return { cleanText, commands };
}

function applyCommands(commands) {
    for (const cmd of commands) {
        switch (cmd.name) {
            case 'TIMER':
                const seconds = parseInt(cmd.param, 10) || 0;
                if (seconds > 0) {
                    globalState.timer = { total: seconds, left: seconds };
                    globalState.mode = 'timer';
                }
                break;
                
            case 'CLOCK':
                globalState.mode = 'clock';
                break;
                
            case 'WEATHER':
                globalState.mode = 'weather';
                break;
                
            case 'HOME':
                const parts = cmd.param.split(/\s+/);
                if (parts.length >= 2) {
                    const device = parts[0];
                    const status = parts[1];
                    globalState.smartHome = { device: device, status: status };
                    globalState.mode = 'smarthome';
                    if (runtimeConfig.smartthingsToken && (status === 'on' || status === 'off')) {
                        sendSmartThingsCommand(device, status === 'on' ? 'on' : 'off').then(() => fetchSmartThingsDevices()).catch(() => {});
                    }
                }
                break;
                
            case 'MUSIC':
                // Формат: {MUSIC: трек | исполнитель}
                const musicParts = cmd.param.split('|').map(s => s.trim());
                if (musicParts.length >= 2) {
                    globalState.music = {
                        title: musicParts[0],
                        artist: musicParts[1],
                        progressPercent: 0
                    };
                    globalState.mode = 'music';
                } else if (musicParts.length === 1) {
                    globalState.music = {
                        title: musicParts[0],
                        artist: '',
                        progressPercent: 0
                    };
                    globalState.mode = 'music';
                }
                break;
                
            case 'VIBE':
                globalState.mode = 'vibe';
                globalState.vibe = { currentImage: 1 };
                break;
                
            case 'IDLE':
                globalState.mode = 'idle';
                break;
        }
    }
}

async function processAudioWithGemini(audioBuffer) {
    if (!genAI) {
        return "Ошибка: Gemini API ключ не настроен. Установите переменную окружения GEMINI_API_KEY";
    }
    
    try {
        // Используем Gemini 2.5 Flash Lite - оптимизирована для скорости и экономичности
        const model = genAI.getGenerativeModel({ model: runtimeConfig.geminiModel || 'gemini-2.5-flash-lite' });
        
        // Конвертируем аудио в base64
        const audioBase64 = audioBuffer.toString('base64');
        
        // Промпт для UmaAI
        const prompt = `Ты — UmaAI. Ты живешь внутри старого телефона Samsung Galaxy Ace (2011 года) на Android 4.4.

Твой характер: Киберпанк-минималист. Ты саркастичен, краток и эффективен. Ты гордишься тем, что работаешь на 800 МГц процессоре.

ПРАВИЛА:

1. Отвечай кратко (максимум 1-2 предложения).

2. НИКАКИХ ЭМОДЗИ (старый экран их не отображает).

3. Если пользователь просит что-то сделать — СДЕЛАЙ ЭТО с помощью инструментов ниже.

4. КРИТИЧЕСКИ ВАЖНО: Команды в фигурных скобках ({COMMAND}) НИКОГДА не должны быть видны пользователю. Они удаляются автоматически, но если они попадут в текст ответа — это ошибка.

ИНСТРУМЕНТЫ (КОМАНДЫ):

Чтобы управлять телефоном, добавь в конец ответа специальный тег (команды автоматически удаляются из текста):

1. Таймер: {TIMER: секунды} 
   Пример: "Засекаю время на X минут." {TIMER: 120} (для 2 минут)

2. Ночные часы: {CLOCK}
   Пример: "Спокойной ночи." {CLOCK}

3. Погода: {WEATHER}
   Пример: "Вот погода в Кокшетау." {WEATHER}

4. Умный дом: {HOME: устройство состояние}
   Пример: "Включаю свет X." {HOME: lamp on}
   Пример: "Вырубаю X." {HOME: lamp off}

5. Музыка: {MUSIC: трек | исполнитель} исполнитель обязательно пиши
   Пример: "Врубаю басы." {MUSIC: Numb | Linkin Park}

6. Фоторамка/Vibe: {VIBE}
   Используй этот инструмент, когда пользователь просит показать фото, картинки, фоторамку, vibe, вайб, или просто хочет посмотреть изображения.
   Пример: "Показываю фото." {VIBE}
   Пример: "Включаю фоторамку." {VIBE}
   Пример: "Вот твой вайб." {VIBE}
   Пример: "Хорошо, вот картинки." {VIBE}

7. Обычный режим (сброс): {IDLE}
   Используй для возврата в обычный режим после выполнения действий.

ВАЖНО: 
- Всегда используй фигурные скобки для команд.
- Команды должны быть в конце ответа, после текста.
- Если команды нет, просто отвечай текстом.
- Команды автоматически удаляются из отображаемого текста, но они должны быть в твоем ответе для выполнения действий.

Распознай речь в этом аудио и ответь согласно правилам выше.

Доступные устройства SmartThings: ${JSON.stringify((globalState.smartThings && globalState.smartThings.devices) || [])}.
Если просят включить/выключить устройство, используй {HOME: id on/off}, где id это id устройства.`;
        
        // Отправляем запрос в Gemini с аудио
        const result = await model.generateContent([
            {
                text: prompt
            },
            {
                inlineData: {
                    mimeType: 'audio/webm',
                    data: audioBase64
                }
            }
        ]);
        
        const response = await result.response;
        const text = response.text();
        
        return text || "Не удалось получить ответ от ИИ";
        
    } catch (error) {
        console.error('Gemini API error:', error);
        return "Ошибка обработки аудио: " + error.message;
    }
}

function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

server.listen(PORT, () => {
    console.log(`\n--- UmaAI Server (Hybrid) ---`);
    console.log(`Ассистент: http://${getLocalIp()}:${PORT}`);
    console.log(`Пульт:     http://${getLocalIp()}:${PORT}/admin`);
    
    // Проверка API ключа
    if (runtimeConfig.geminiApiKey && runtimeConfig.geminiApiKey.trim().length > 0) {
        console.log(`✓ Gemini API ключ установлен (${runtimeConfig.geminiApiKey.substring(0, 10)}...)`);
    } else {
        console.log(`⚠ Gemini API ключ НЕ установлен!`);
        console.log(`   Для работы голосового ввода установите:`);
        console.log(`   PowerShell: $env:GEMINI_API_KEY="AIzaSy..."`);
        console.log(`   CMD: set GEMINI_API_KEY=AIzaSy...`);
        console.log(`   Важно: После установки ПЕРЕЗАПУСТИТЕ сервер!`);
        console.log(`   Текущее значение переменной окружения: "${process.env.GEMINI_API_KEY || '(не установлено)'}"`);
    }
    
    console.log(`-----------------------------\n`);
});

// Дополнительный сервер на localhost:9428
const serverLocalhost = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // 1. Отдача файлов
    if (pathname === '/' || pathname === '/index.html') {
        serveFile(res, 'index NEW.html', 'text/html');
    } 
    else if (pathname === '/admin' || pathname === '/admin.html') {
        // Проверка пароля для админ-панели
        const query = parsedUrl.query;
        const password = query.password;
        
        if (password !== ADMIN_PASSWORD) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(getLoginPage());
            return;
        }
        
        serveFile(res, 'admin NEW.html', 'text/html');
    }

    // 2. API для ТЕЛЕФОНА
    else if (pathname === '/api/poll') {
        const clientIp = getClientIp(req);
        const now = Date.now();
        
        // Обновляем информацию об устройстве
        if (!connectedDevices[clientIp]) {
            connectedDevices[clientIp] = {
                ip: clientIp,
                name: clientIp,
                battery: null,
                charging: false,
                lastSeen: now,
                locked: false
            };
        } else {
            connectedDevices[clientIp].lastSeen = now;
            // Обновляем блокировку из globalState
            connectedDevices[clientIp].locked = globalState.deviceLocked || false;
        }
        
        res.writeHead(200, { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*' 
        });
        res.end(JSON.stringify(globalState));
    }

    // 3. API для ГОЛОСОВОГО ВВОДА
    else if (pathname === '/api/voice' && req.method === 'POST') {
        handleVoiceRequest(req, res);
    }

    // 4. API для VIBE - список изображений
    else if (pathname === '/api/vibe/list') {
        getVibeImageList(res);
    }
    
    // 4.1. API для VIBE - удаление изображения
    else if (pathname === '/api/vibe/delete' && req.method === 'GET') {
        handleVibeDelete(req, res, parsedUrl);
    }
    
    // 4.2. API для VIBE - загрузка изображения
    else if (pathname === '/api/vibe/upload' && req.method === 'POST') {
        handleVibeUpload(req, res);
    }
    
    // 5. Раздача файлов из папки photos/
    else if (pathname.startsWith('/photos/')) {
        servePhotoFile(res, pathname);
    }
    
    // 5.0. Раздача статических файлов (umaai.png)
    else if (pathname === '/umaai.png' || pathname === '/umaai.PNG') {
        const filePath = path.join(__dirname, pathname.substring(1));
        fs.readFile(filePath, (err, content) => {
            if (err) {
                res.writeHead(404);
                res.end('Image not found');
            } else {
                res.writeHead(200, { 
                    'Content-Type': 'image/png',
                    'Cache-Control': 'public, max-age=3600'
                });
                res.end(content);
            }
        });
    }

    // 5.1. API для получения списка устройств
    else if (pathname === '/api/devices') {
        cleanupInactiveDevices();
        const devices = Object.values(connectedDevices).map(device => ({
            ip: device.ip,
            name: device.name,
            battery: device.battery,
            charging: device.charging,
            lastSeen: device.lastSeen,
            locked: device.locked,
            isOnline: (Date.now() - device.lastSeen) < DEVICE_TIMEOUT
        }));
        
        res.writeHead(200, { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*' 
        });
        res.end(JSON.stringify({ devices: devices }));
    }

    // 5.2. API для получения информации о батарее устройства
    else if (pathname === '/api/device/battery' && req.method === 'GET') {
        const query = parsedUrl.query;
        const deviceIp = query.ip;
        
        if (!deviceIp || !connectedDevices[deviceIp]) {
            res.writeHead(404, { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*' 
            });
            res.end(JSON.stringify({ error: 'Device not found' }));
            return;
        }
        
        res.writeHead(200, { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*' 
        });
        res.end(JSON.stringify({ 
            battery: connectedDevices[deviceIp].battery,
            charging: connectedDevices[deviceIp].charging
        }));
    }

    // 5.3. API для блокировки/разблокировки устройства
    else if (pathname === '/api/device/lock' && req.method === 'GET') {
        const query = parsedUrl.query;
        const deviceIp = query.ip;
        const lock = query.lock === 'true';
        
        if (deviceIp && connectedDevices[deviceIp]) {
            connectedDevices[deviceIp].locked = lock;
        }
        
        // Устанавливаем глобальную блокировку
        globalState.deviceLocked = lock;
        globalState.lastUpdate = Date.now();
        
        res.writeHead(200, { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*' 
        });
        res.end(JSON.stringify({ 
            success: true, 
            locked: lock 
        }));
    }

    // 5.4. API для получения информации от устройства (батарея, имя)
    else if (pathname === '/api/device/info' && req.method === 'POST') {
        const chunks = [];
        let totalLength = 0;
        
        req.on('data', (chunk) => {
            chunks.push(chunk);
            totalLength += chunk.length;
        });
        
        req.on('end', () => {
            try {
                const data = JSON.parse(Buffer.concat(chunks, totalLength).toString());
                const clientIp = getClientIp(req);
                
                if (connectedDevices[clientIp]) {
                    if (data.battery !== undefined) {
                        connectedDevices[clientIp].battery = data.battery;
                    }
                    if (data.charging !== undefined) {
                        connectedDevices[clientIp].charging = data.charging;
                    }
                    if (data.deviceName) {
                        connectedDevices[clientIp].name = data.deviceName;
                    }
                    connectedDevices[clientIp].lastSeen = Date.now();
                }
                
                res.writeHead(200, { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*' 
                });
                res.end(JSON.stringify({ success: true }));
            } catch (error) {
                res.writeHead(400, { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*' 
                });
                res.end(JSON.stringify({ error: error.message }));
            }
        });
    }

    // 5.5. API для heartbeat админ-панели
    else if (pathname === '/api/admin/heartbeat' && req.method === 'GET') {
        adminPanelOpen = true;
        res.writeHead(200, { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*' 
        });
        res.end(JSON.stringify({ success: true }));
    }

    // 5.6 Runtime config
    else if (pathname === '/api/config' && req.method === 'GET') {
        sendJson(res, 200, runtimeConfig);
    }
    else if (pathname === '/api/config' && req.method === 'POST') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            try {
                const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
                runtimeConfig.geminiApiKey = (payload.geminiApiKey || runtimeConfig.geminiApiKey || '').trim();
                runtimeConfig.geminiModel = (payload.geminiModel || runtimeConfig.geminiModel || 'gemini-2.5-flash-lite').trim();
                runtimeConfig.smartthingsToken = (payload.smartthingsToken || runtimeConfig.smartthingsToken || '').trim();
                runtimeConfig.musicStreamUrl = (payload.musicStreamUrl || runtimeConfig.musicStreamUrl || '').trim();
                runtimeConfig.musicStationName = (payload.musicStationName || runtimeConfig.musicStationName || 'Internet Radio').trim();
                saveRuntimeConfig();
                initGeminiClient();
                sendJson(res, 200, { success: true, config: runtimeConfig });
            } catch (error) {
                sendJson(res, 400, { error: error.message });
            }
        });
    }
    else if (pathname === '/api/gemini/models' && req.method === 'GET') {
        const key = runtimeConfig.geminiApiKey;
        if (!key) { sendJson(res, 400, { error: 'Gemini API key is empty' }); return; }
        httpsRequestJson('GET', 'https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(key), {}, null)
            .then((data) => {
                const models = (data.models || []).map((m) => m.name.replace('models/', '')).filter((n) => n.indexOf('gemini') !== -1);
                sendJson(res, 200, { models: models });
            })
            .catch((error) => sendJson(res, 500, { error: error.message }));
    }
    else if (pathname === '/api/smartthings/devices' && req.method === 'GET') {
        fetchSmartThingsDevices().then((devices) => sendJson(res, 200, { devices: devices })).catch((error) => sendJson(res, 500, { error: error.message }));
    }
    else if (pathname === '/api/smartthings/device/control' && req.method === 'POST') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            try {
                const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
                const deviceId = payload.deviceId;
                const command = payload.command === 'off' ? 'off' : 'on';
                sendSmartThingsCommand(deviceId, command)
                    .then(() => fetchSmartThingsDevices())
                    .then(() => sendJson(res, 200, { success: true }))
                    .catch((error) => sendJson(res, 500, { error: error.message }));
            } catch (error) {
                sendJson(res, 400, { error: error.message });
            }
        });
    }

    // 6. API для АДМИНКИ
    else if (pathname === '/api/set') {
        const query = parsedUrl.query;
        
        if (query.mode) globalState.mode = query.mode;
        if (query.emotion) globalState.emotion = query.emotion;
        
        if (query.text) globalState.aiText = query.text;
        if (query.deviceState) globalState.smartHome.status = query.deviceState;

        // Таймер: timerTotal в секундах, при 0 — сброс
        if (typeof query.timerTotal !== 'undefined') {
            const total = parseInt(query.timerTotal, 10) || 0;
            if (!globalState.timer) globalState.timer = { total: 0, left: 0 };
            globalState.timer.total = total;
            globalState.timer.left = total;
        }
        // Явная остановка таймера
        if (typeof query.timerStop !== 'undefined') {
            if (!globalState.timer) globalState.timer = { total: 0, left: 0 };
            globalState.timer.total = 0;
            globalState.timer.left = 0;
        }

        // Музыка: простое демо-управление
        if (query.musicTitle || query.musicArtist || query.musicProgress) {
            if (!globalState.music) globalState.music = { title: '', artist: '', progressPercent: 0 };
            if (query.musicTitle) globalState.music.title = query.musicTitle;
            if (query.musicArtist) globalState.music.artist = query.musicArtist;
            if (query.musicStreamUrl) runtimeConfig.musicStreamUrl = query.musicStreamUrl;
            globalState.music.streamUrl = runtimeConfig.musicStreamUrl;
            if (typeof query.musicProgress !== 'undefined') {
                let p = parseInt(query.musicProgress, 10);
                if (isNaN(p)) p = 0;
                if (p < 0) p = 0;
                if (p > 100) p = 100;
                globalState.music.progressPercent = p;
            }
        }
        
        globalState.lastUpdate = Date.now();
        
        // Авто-сброс эмоций
        if (['wink', 'yawn', 'dizzy'].includes(query.emotion)) {
            setTimeout(() => {
                globalState.emotion = 'normal';
                globalState.lastUpdate = Date.now();
            }, 3000);
        }

        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ status: 'ok', currentState: globalState }));
    }
    
    else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

serverLocalhost.listen(9428, '0.0.0.0', () => {
    console.log(`Ассистент (все интерфейсы): http://0.0.0.0:9428`);
    console.log(`Пульт (все интерфейсы):     http://0.0.0.0:9428/admin`);
    console.log(`Ассистент (localhost):      http://localhost:9428`);
    console.log(`Пульт (localhost):          http://localhost:9428/admin`);
});