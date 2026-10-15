const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let alertWindows = [];
let tray = null;
let isQuitting = false;

const notifiedAlerts = new Set();
let cachedZone = null;
let cachedState = null;

const configPath = path.join(app.getPath('userData'), 'config.json');

async function loadZone() {
  if (!fs.existsSync(configPath)) {
    console.log('[Setup] config.json not found yet in userData.');
    return false;
  }

  try {
    const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    let lat, lon;

    if (configData.type === 'coords' || (configData.lat && configData.lon)) {
      lat = configData.lat;
      lon = configData.lon;
      console.log(`[Location] Using coordinates: Lat: ${lat}, Lon: ${lon}`);
    } else if (configData.zipCode) {
      console.log(`[Location] Resolving ZIP code: ${configData.zipCode}...`);
      const zipRes = await fetch(`https://api.zippopotam.us/us/${configData.zipCode}`);
      if (!zipRes.ok) return false;
      
      const zipData = await zipRes.json();
      if (zipData && zipData.places && zipData.places.length > 0) {
        cachedState = zipData.places[0]['state abbreviation'];
        lat = parseFloat(zipData.places[0].latitude).toFixed(4);
        lon = parseFloat(zipData.places[0].longitude).toFixed(4);
      }
    }

    if (!lat || !lon) {
      console.error('[Location] Could not determine valid coordinates.');
      return false;
    }

    console.log(`[NWS] Fetching forecast zone metadata for Lat: ${lat}, Lon: ${lon}...`);
    const pointRes = await fetch(`https://api.weather.gov/points/${lat},${lon}`, {
      headers: { 'User-Agent': '(DesktopEASClient, developer@yourdomain.com)' }
    });

    if (!pointRes.ok) {
      console.warn(`[NWS] Points metadata failed (Status ${pointRes.status}).`);
      return false;
    }

    const pointData = await pointRes.json();
    
    // Safely extract state and forecast zone
    if (pointData.properties?.relativeLocation?.properties?.state) {
      cachedState = pointData.properties.relativeLocation.properties.state;
    }

    if (pointData.properties?.forecastZone) {
      const forecastZoneUrl = pointData.properties.forecastZone;
      cachedZone = forecastZoneUrl.split('/').pop();
    }

    console.log(`[NWS] SUCCESS! Forecast Zone locked to: ${cachedZone} in state: ${cachedState}`);
    return true;
  } catch (err) {
    console.error('[Error] Failed resolving location configuration:', err);
  }
  return false;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 650,
    height: 570,
    show: false,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function showFullScreenAlert(alertData) {
  closeAllAlerts();
  const displays = screen.getAllDisplays();

  displays.forEach((display) => {
    const alertWindow = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      fullscreen: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });

    alertWindow.loadFile('alert.html');

    alertWindow.webContents.once('did-finish-load', () => {
      alertWindow.webContents.send('set-alert-data', {
        event: alertData.properties.event,
        headline: alertData.properties.headline,
        description: alertData.properties.description
      });
    });

    alertWindows.push(alertWindow);
  });
}

function closeAllAlerts() {
  alertWindows.forEach(win => {
    if (win && !win.isDestroyed()) {
      win.close();
    }
  });
  alertWindows = [];
}

ipcMain.on('dismiss-alert', () => {
  closeAllAlerts();
});

ipcMain.handle('get-config', () => {
  if (fs.existsSync(configPath)) {
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      return {};
    }
  }
  return {};
});

// Robust IP-based auto-detection handler for desktop environments
ipcMain.handle('auto-detect-ip', async () => {
  try {
    console.log('[Location] Auto-detecting location via IP network lookup...');
    const res = await fetch('http://ip-api.com/json/');
    if (res.ok) {
      const data = await res.json();
      if (data.status === 'success') {
        console.log(`[Location] Detected: ${data.city}, ${data.region} (${data.lat}, ${data.lon})`);
        return { lat: data.lat.toFixed(4), lon: data.lon.toFixed(4), city: data.city, region: data.region };
      }
    }
  } catch (err) {
    console.error('[Error] IP location lookup failed:', err);
  }
  return null;
});

ipcMain.on('save-config', async (event, configPayload) => {
  console.log('[Setup] Saving configuration:', configPayload);
  try {
    fs.writeFileSync(configPath, JSON.stringify(configPayload));

    cachedZone = null;
    cachedState = null;
    const loaded = await loadZone();
    
    if (loaded) {
      pollNWSAlerts();
    }

    if (mainWindow) {
      mainWindow.hide();
    }
  } catch (err) {
    console.error('[Error] Failed to save configuration file:', err);
  }
});

async function pollNWSAlerts() {
  if (!cachedState) {
    console.log('[Poll] Skipping: State not configured yet.');
    return; 
  }

  const url = `https://api.weather.gov/alerts/active?area=${cachedState}`;
  console.log(`[NWS] Polling active alerts for state: ${cachedState} (${url})`);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': '(DesktopEASClient, developer@yourdomain.com)'
      }
    });

    if (!response.ok) {
      console.warn(`[NWS] API returned status ${response.status}`);
      return;
    }

    const data = await response.json();
    const features = data.features || [];
    console.log(`[NWS] Found ${features.length} active alert(s) in ${cachedState}. Current target zone: ${cachedZone || 'None'}`);

    features.forEach(alert => {
      const props = alert.properties;
      const affectedZones = props.affectedZones || [];
      
      const isRelevant = cachedZone 
        ? affectedZones.some(zoneUrl => zoneUrl.includes(cachedZone))
        : true;

      console.log(` -> Alert: "${props.event}" | Zones affected: [${affectedZones.map(z => z.split('/').pop()).join(', ')}] | Match? ${isRelevant}`);

      if (isRelevant) {
        const alertId = props.id;
        if (!notifiedAlerts.has(alertId)) {
          notifiedAlerts.add(alertId);
          console.log(`[ALERT TRIGGER] Firing overlay for: ${props.event}`);
          showFullScreenAlert(alert);
        } else {
          console.log(` -> Alert ${alertId} already notified this session. Skipping.`);
        }
      }
    });
  } catch (error) {
    console.error('[Error] Failed to poll NWS alerts:', error);
  }
}

app.whenReady().then(async () => {
  createWindow();

  if (fs.existsSync(configPath)) {
    const loaded = await loadZone();
    if (loaded) {
      pollNWSAlerts();
    }
  }

  app.setLoginItemSettings({
    openAtLogin: true,
    path: process.execPath,
    args: ['--hidden']
  });

  const isHidden = process.argv.includes('--hidden');
  if (!isHidden) {
    mainWindow.show();
  }

  const iconPath = path.join(__dirname, 'icon.ico');
  const trayIcon = nativeImage.createFromPath(iconPath);
  tray = new Tray(trayIcon.isEmpty() ? nativeImage.createEmpty() : trayIcon);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open Setup / Dashboard', click: () => mainWindow.show() },
    { type: 'separator' },
    { label: 'Quit Application', click: () => { isQuitting = true; app.quit(); } }
  ]);

  tray.setToolTip('Desktop EAS Client (Monitoring)');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });

  setInterval(pollNWSAlerts, 20000);
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});