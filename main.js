const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { autoUpdater } = require('electron-updater');

if (process.platform === 'win32') {
    app.setAppUserModelId('com.sampsons.wallpaperengine');
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
    app.quit();
} else {
    let mainWindow = null;
    let videoWindow = null;
    let tray = null;
    let isQuitting = false;

    const libraryDir = () => path.join(app.getPath('userData'), 'wallpapers');
    const dataFile = () => path.join(app.getPath('userData'), 'wallpapers.json');
    const wallpaperStateFile = () => path.join(app.getPath('userData'), 'active-wallpaper-state.json');
    const playlistsFile = () => path.join(app.getPath('userData'), 'playlists.json');
    const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

    const videoDiagnosticFile = () =>
        path.join(app.getPath('userData'), 'video-wallpaper-diagnostics.txt');

    function diagnosticLog(message, details = null) {
        const timestamp = new Date().toISOString();
        let line = `[${timestamp}] ${message}`;

        if (details !== null && details !== undefined) {
            try {
                line += '\n' + (typeof details === 'string'
                    ? details
                    : JSON.stringify(details, null, 2));
            } catch (error) {
                line += '\n' + String(details);
            }
        }

        try {
            const logFile = videoDiagnosticFile();
            fs.mkdirSync(path.dirname(logFile), { recursive: true });
            fs.appendFileSync(logFile, line + '\n\n', 'utf8');
        } catch (error) {
            console.error('Could not write video diagnostic log:', error);
        }

        console.log('[VIDEO DIAGNOSTIC]', message, details || '');
    }

    const defaultSettings = {
        autoOpen: false,
        autoPlay: true,
        startMinimized: false,
        minimizeToTray: true,
        defaultView: 'grid',
        defaultFade: 1,
        defaultPhotoDuration: 10,
        rememberLastPage: true,
        lastPage: 'home'
    };

    function readJson(file, fallback) {
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            return fallback;
        }
    }

    function writeJson(file, data) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    }

    function readSettings() {
        const saved = readJson(settingsFile(), {});
        const result = { ...defaultSettings, ...saved };

        if (result.lastPage === 'calendar') {
            result.lastPage = 'widgets';
        }

        const allowedPages = ['home', 'library', 'playlists', 'settings', 'widgets'];

        if (!allowedPages.includes(result.lastPage)) {
            result.lastPage = 'home';
        }

        return result;
    }

    function writeSettings(settings) {
        writeJson(settingsFile(), settings);
    }

    function applyStartupSetting(enabled) {
        if (process.platform !== 'win32' || !app.isPackaged) return;

        const settings = readSettings();

        app.setLoginItemSettings({
            openAtLogin: enabled,
            openAsHidden: enabled && settings.startMinimized
        });
    }

    function readLibrary() {
        const data = readJson(dataFile(), []);
        return Array.isArray(data) ? data : [];
    }

    function writeLibrary(items) {
        writeJson(dataFile(), items);
    }

    function readPlaylists() {
        const data = readJson(playlistsFile(), []);
        return Array.isArray(data) ? data : [];
    }

    function writePlaylists(items) {
        writeJson(playlistsFile(), items);
    }

    function readWallpaperState() {
        return readJson(wallpaperStateFile(), {
            wallpaperChangedByApp: false,
            originalWallpaper: null,
            lastActive: null
        });
    }

    function writeWallpaperState(state) {
        writeJson(wallpaperStateFile(), state);
    }

    function runPowerShell(script) {
        return new Promise((resolve, reject) => {
            execFile(
                'powershell.exe',
                ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
                { windowsHide: true, timeout: 15000 },
                (error, stdout, stderr) => {
                    if (error) reject(new Error(stderr?.trim() || error.message));
                    else resolve(stdout.trim());
                }
            );
        });
    }

    async function rememberOriginalWallpaper() {
        const state = readWallpaperState();

        if (state.wallpaperChangedByApp) return state;

        try {
            const result = await runPowerShell(
                "(Get-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name Wallpaper).Wallpaper"
            );

            state.originalWallpaper = result || null;
        } catch {
            state.originalWallpaper = null;
        }

        state.wallpaperChangedByApp = false;
        writeWallpaperState(state);

        return state;
    }

    function closeVideoWallpaper() {
        if (videoWindow && !videoWindow.isDestroyed()) {
            videoWindow.close();
        }

        videoWindow = null;
    }

    function showMainWindow() {
        if (!mainWindow || mainWindow.isDestroyed()) {
            createWindow();
            return;
        }

        if (mainWindow.isMinimized()) {
            mainWindow.restore();
        }

        mainWindow.show();
        mainWindow.focus();
    }

    function createTray() {
        if (tray) return;

        const iconPath = path.join(__dirname, 'assets', 'sampsons-app-icon.png');

        const icon = fs.existsSync(iconPath)
            ? nativeImage.createFromPath(iconPath)
            : nativeImage.createEmpty();

        tray = new Tray(icon);
        tray.setToolTip('Sampsons Wallpaper Engine');

        tray.setContextMenu(Menu.buildFromTemplate([
            {
                label: 'Open Sampsons Wallpaper Engine',
                click: showMainWindow
            },
            {
                label: 'Remove Active Wallpaper',
                click: async () => {
                    try {
                        await removeWallpaper();
                    } catch (error) {
                        dialog.showErrorBox('Wallpaper Error', error.message);
                    }
                }
            },
            { type: 'separator' },
            {
                label: 'Quit',
                click: () => {
                    isQuitting = true;
                    closeVideoWallpaper();
                    app.quit();
                }
            }
        ]));

        tray.on('double-click', showMainWindow);
    }

    function createWindow() {
        if (mainWindow && !mainWindow.isDestroyed()) {
            showMainWindow();
            return;
        }

        const settings = readSettings();
        const indexPath = path.join(__dirname, 'index.html');

        console.log('App folder:', __dirname);
        console.log('Loading HTML:', indexPath);
        console.log('HTML exists:', fs.existsSync(indexPath));
        console.log('Packaged:', app.isPackaged);

        const windowIconPath = path.join(__dirname, 'assets', 'sampsons-app-icon.ico');
        const windowIcon = nativeImage.createFromPath(windowIconPath);

        console.log('Window icon loaded:', !windowIcon.isEmpty());
        console.log('Window icon size:', windowIcon.getSize());

        mainWindow = new BrowserWindow({
            width: 1200,
            height: 800,
            minWidth: 900,
            minHeight: 600,
            title: 'Sampsons Wallpaper Engine',
            icon: windowIcon,
            frame: true,
            skipTaskbar: false,
            backgroundColor: '#0d0b14',
        show: !settings.startMinimized,
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false
            }
        });

        mainWindow.setIcon(windowIcon);

        mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
            console.error('HTML failed to load:', code, description);
        });

        mainWindow.webContents.on('console-message', (_event, details) => {
            console.log('Renderer console:', details.message);
        });

        mainWindow.loadFile(indexPath);

        if (settings.startMinimized) {
            mainWindow.once('ready-to-show', () => {
                if (settings.minimizeToTray) {
                    mainWindow.hide();
                } else {
                    mainWindow.minimize();
                }
            });
        }

        mainWindow.on('close', event => {
            const current = readSettings();

            if (!isQuitting && current.minimizeToTray) {
                event.preventDefault();
                mainWindow.hide();
            }
        });

        mainWindow.on('closed', () => {
            mainWindow = null;
        });
    }

    function getVideoHelperPath() {
        const possiblePaths = [
            path.join(process.resourcesPath, 'VideoWallpaper', 'VideoWallpaper.exe'),
            path.join(__dirname, 'VideoWallpaper', 'VideoWallpaper.exe'),
            path.join(
                __dirname,
                'VideoWallpaper',
                'bin',
                'Debug',
                'net8.0-windows',
                'VideoWallpaper.exe'
            ),
            path.join(
                __dirname,
                'VideoWallpaper',
                'bin',
                'Release',
                'net8.0-windows',
                'VideoWallpaper.exe'
            )
        ];

        const pathChecks = possiblePaths.map(candidate => {
            let exists = false;
            let size = null;
            let modified = null;

            try {
                const stats = fs.statSync(candidate);
                exists = stats.isFile();
                size = stats.size;
                modified = stats.mtime.toISOString();
            } catch {
                // Missing paths are expected when checking dev/packaged paths.
            }

            return { path: candidate, exists, size, modified };
        });

        const foundPath = pathChecks.find(item => item.exists)?.path || null;

        diagnosticLog('Video helper path search completed', {
            isPackaged: app.isPackaged,
            platform: process.platform,
            resourcesPath: process.resourcesPath,
            appDirectory: __dirname,
            candidates: pathChecks,
            selectedHelper: foundPath
        });

        return foundPath;
    }

    async function attachToDesktop(win) {
        diagnosticLog('attachToDesktop called', {
            platform: process.platform,
            isPackaged: app.isPackaged,
            windowDestroyed: !win || win.isDestroyed()
        });

        if (process.platform !== 'win32') {
            throw new Error('Video wallpapers are currently supported on Windows only.');
        }

        if (!win || win.isDestroyed()) {
            throw new Error('The video wallpaper window was closed before it could be attached.');
        }

        const helperExe = getVideoHelperPath();

        if (!helperExe) {
            diagnosticLog('Video helper executable was NOT found');
            throw new Error(
                'VideoWallpaper.exe could not be found. Check the VideoWallpaper helper build and installer files.'
            );
        }

        let nativeHandle;
        let handleNumber;

        try {
            nativeHandle = win.getNativeWindowHandle();
            handleNumber = nativeHandle.readBigUInt64LE(0).toString();
        } catch (error) {
            diagnosticLog('Could not read the native video window handle', {
                message: error.message,
                stack: error.stack
            });

            throw new Error('Could not read the video wallpaper window handle: ' + error.message);
        }

        const launchDetails = {
            helperExe,
            helperExists: fs.existsSync(helperExe),
            handleNumber,
            handleHex: '0x' + BigInt(handleNumber).toString(16),
            nativeHandleBufferLength: nativeHandle.length,
            nativeHandleBufferHex: nativeHandle.toString('hex'),
            windowVisible: win.isVisible(),
            windowBounds: win.getBounds(),
            userData: app.getPath('userData')
        };

        diagnosticLog('Launching VideoWallpaper helper', launchDetails);

        await new Promise((resolve, reject) => {
            let settled = false;

            const child = execFile(
                helperExe,
                [handleNumber],
                {
                    windowsHide: true,
                    timeout: 15000,
                    maxBuffer: 1024 * 1024
                },
                (error, stdout, stderr) => {
                    const resultDetails = {
                        helperExe,
                        handleNumber,
                        error: error ? {
                            message: error.message,
                            code: error.code,
                            errno: error.errno,
                            syscall: error.syscall,
                            path: error.path,
                            spawnargs: error.spawnargs,
                            killed: error.killed,
                            signal: error.signal,
                            stack: error.stack
                        } : null,
                        stdout: stdout || '',
                        stderr: stderr || ''
                    };

                    diagnosticLog('VideoWallpaper helper process completed', resultDetails);

                    if (settled) return;
                    settled = true;

                    if (error) {
                        reject(new Error(
                            'Could not attach wallpaper to the desktop.\n\n' +
                            'Helper: ' + helperExe + '\n' +
                            'Window handle: ' + handleNumber + '\n' +
                            'Diagnostic log: ' + videoDiagnosticFile() + '\n\n' +
                            'Details: ' + (stderr?.trim() || stdout?.trim() || error.message)
                        ));
                        return;
                    }

                    diagnosticLog('VideoWallpaper helper exited successfully', {
                        helperExe,
                        handleNumber
                    });

                    resolve(true);
                }
            );

            child.once('spawn', () => {
                diagnosticLog('Windows successfully spawned the video helper process', {
                    pid: child.pid,
                    helperExe,
                    handleNumber
                });
            });

            child.once('error', error => {
                diagnosticLog('Video helper process emitted an error event', {
                    message: error.message,
                    code: error.code,
                    stack: error.stack,
                    helperExe,
                    handleNumber
                });
            });
        });
    }

    function createWallpaperWindow() {
        const win = new BrowserWindow({
            width: 800,
            height: 600,
            frame: false,
            show: false,
            backgroundColor: '#000000',
            webPreferences: {
                contextIsolation: true,
                nodeIntegration: false
            }
        });

        videoWindow = win;

        win.on('closed', () => {
            if (videoWindow === win) {
                videoWindow = null;
            }
        });

        return win;
    }

    async function setImageWallpaper(filePath, saveAsLast = true) {
        if (
            typeof filePath !== 'string' ||
            !path.isAbsolute(filePath) ||
            !fs.existsSync(filePath)
        ) {
            throw new Error('Invalid image file.');
        }

        if (!['.jpg', '.jpeg', '.png', '.bmp'].includes(path.extname(filePath).toLowerCase())) {
            throw new Error('Please select an existing JPG, PNG, or BMP image.');
        }

        const state = await rememberOriginalWallpaper();
        closeVideoWallpaper();

        const safePath = filePath.replace(/'/g, "''");

        const script = `
            Add-Type -TypeDefinition '
            using System;
            using System.Runtime.InteropServices;
            public class WallpaperSetter {
                [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
                public static extern bool SystemParametersInfo(int action, int param, string path, int flags);
            }'
            $result = [WallpaperSetter]::SystemParametersInfo(20, 0, '${safePath}', 3)
            if (-not $result) { throw "Windows could not change the wallpaper." }
        `;

        await runPowerShell(script);

        state.wallpaperChangedByApp = true;

        if (saveAsLast) {
            state.lastActive = { type: 'image', filePath };
        }

        writeWallpaperState(state);
        return true;
    }

    async function setVideoWallpaper(options, saveAsLast = true) {
        const { filePath, startTime = 0, endTime = 0 } = options || {};

        if (
            typeof filePath !== 'string' ||
            !path.isAbsolute(filePath) ||
            !fs.existsSync(filePath)
        ) {
            throw new Error('Invalid video file.');
        }

        if (!['.mp4', '.webm', '.mov', '.m4v'].includes(path.extname(filePath).toLowerCase())) {
            throw new Error('Unsupported video format.');
        }

        if (
            !Number.isFinite(startTime) ||
            !Number.isFinite(endTime) ||
            startTime < 0 ||
            endTime < 0 ||
            (endTime > 0 && endTime <= startTime)
        ) {
            throw new Error('Please enter valid video start and end times.');
        }

        const state = await rememberOriginalWallpaper();
        closeVideoWallpaper();

        const win = createWallpaperWindow();

        diagnosticLog('Starting single video wallpaper setup', {
            filePath,
            startTime,
            endTime,
            videoHtml: path.join(__dirname, 'video.html'),
            videoHtmlExists: fs.existsSync(path.join(__dirname, 'video.html'))
        });

        try {
            await win.loadFile(path.join(__dirname, 'video.html'), {
                query: {
                    video: pathToFileURL(filePath).href,
                    start: String(startTime),
                    end: String(endTime)
                }
            });

            diagnosticLog('Video HTML loaded successfully', {
                windowDestroyed: win.isDestroyed(),
                windowVisibleBeforeShow: win.isVisible(),
                nativeHandle: win.getNativeWindowHandle().toString('hex')
            });

            win.showInactive();

            diagnosticLog('Video wallpaper window shown inactive', {
                windowVisible: win.isVisible(),
                bounds: win.getBounds(),
                nativeHandle: win.getNativeWindowHandle().toString('hex')
            });

            await attachToDesktop(win);

            win.filePath = filePath;
            state.wallpaperChangedByApp = true;

            if (saveAsLast) {
                state.lastActive = {
                    type: 'video',
                    filePath,
                    startTime,
                    endTime
                };
            }

            writeWallpaperState(state);
            return true;
        } catch (error) {
            diagnosticLog('FAILED to set video wallpaper', {
                message: error.message,
                stack: error.stack,
                filePath,
                windowDestroyed: win.isDestroyed()
            });

            console.error('Failed to set video wallpaper:', error);
            closeVideoWallpaper();
            throw error;
        }
    }

    async function playPlaylist(playlist, saveAsLast = true) {
        if (!playlist || !Array.isArray(playlist.items) || !playlist.items.length) {
            throw new Error('This playlist is empty.');
        }

        const state = await rememberOriginalWallpaper();
        closeVideoWallpaper();

        const validItems = playlist.items.filter(item =>
            item &&
            typeof item.filePath === 'string' &&
            fs.existsSync(item.filePath)
        );

        if (!validItems.length) {
            throw new Error('No available files were found in this playlist.');
        }

        const playerPlaylist = {
            ...playlist,
            items: validItems.map(item => ({
                ...item,
                filePath: pathToFileURL(item.filePath).href
            }))
        };

        const encoded = Buffer
            .from(JSON.stringify(playerPlaylist), 'utf8')
            .toString('base64');

        const win = createWallpaperWindow();

        try {
            await win.loadFile(path.join(__dirname, 'video.html'), {
                query: { playlist: encoded }
            });

            win.showInactive();
            await attachToDesktop(win);

            win.filePath = '__playlist__';
            state.wallpaperChangedByApp = true;

            if (saveAsLast) {
                state.lastActive = {
                    type: 'playlist',
                    playlistId: playlist.id
                };
            }

            writeWallpaperState(state);
            return true;
        } catch (error) {
            console.error('Failed to play playlist:', error);
            closeVideoWallpaper();
            throw error;
        }
    }

    async function removeWallpaper() {
        closeVideoWallpaper();

        const state = readWallpaperState();

        if (state.wallpaperChangedByApp && state.originalWallpaper) {
            const safePath = state.originalWallpaper.replace(/'/g, "''");

            const script = `
                Add-Type -TypeDefinition '
                using System;
                using System.Runtime.InteropServices;
                public class WallpaperRestore {
                    [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
                    public static extern bool SystemParametersInfo(int action, int param, string path, int flags);
                }'
                $result = [WallpaperRestore]::SystemParametersInfo(20, 0, '${safePath}', 3)
                if (-not $result) { throw "Windows could not restore the previous wallpaper." }
            `;

            await runPowerShell(script);
        } else if (state.wallpaperChangedByApp) {
            await runPowerShell('RUNDLL32.EXE user32.dll,UpdatePerUserSystemParameters');
        }

        state.wallpaperChangedByApp = false;
        state.lastActive = null;
        writeWallpaperState(state);

        return true;
    }

    function wait(milliseconds) {
        return new Promise(resolve => setTimeout(resolve, milliseconds));
    }

    async function restoreLastWallpaper() {
        const state = readWallpaperState();
        const last = state.lastActive;

        if (!last) return false;

        if (last.type === 'image' && fs.existsSync(last.filePath)) {
            await setImageWallpaper(last.filePath, false);
            return true;
        }

        if (last.type === 'video' && fs.existsSync(last.filePath)) {
            await setVideoWallpaper(last, false);
            return true;
        }

        if (last.type === 'playlist') {
            const playlist = readPlaylists().find(item => item.id === last.playlistId);

            if (playlist) {
                await playPlaylist(playlist, false);
                return true;
            }
        }

        return false;
    }

    async function restoreWallpaperAtStartup() {
        const state = readWallpaperState();

        if (!state.lastActive) {
            diagnosticLog('Startup restoration skipped: no saved active wallpaper');
            return false;
        }

        diagnosticLog('Waiting for Windows desktop before restoring wallpaper', {
            delayMilliseconds: 12000,
            lastActive: state.lastActive
        });

        await wait(12000);

        const maxAttempts = 3;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                diagnosticLog('Starting automatic wallpaper restoration', {
                    attempt,
                    maxAttempts,
                    lastActive: readWallpaperState().lastActive
                });

                const restored = await restoreLastWallpaper();

                diagnosticLog('Automatic wallpaper restoration finished', {
                    attempt,
                    restored
                });

                return restored;
            } catch (error) {
                diagnosticLog('Automatic wallpaper restoration attempt failed', {
                    attempt,
                    maxAttempts,
                    message: error.message,
                    stack: error.stack
                });

                console.error(
                    `Wallpaper restoration attempt ${attempt} of ${maxAttempts} failed:`,
                    error
                );

                if (attempt < maxAttempts) {
                    await wait(5000);
                }
            }
        }

        diagnosticLog('Automatic wallpaper restoration failed after all attempts', {
            maxAttempts
        });

        return false;
    }

    // LIBRARY IPC

    ipcMain.handle('library:list', async () => {
        fs.mkdirSync(libraryDir(), { recursive: true });

        return readLibrary()
            .filter(item => fs.existsSync(item.filePath))
            .map(item => ({
                ...item,
                url: pathToFileURL(item.filePath).href
            }));
    });

    ipcMain.handle('library:import', async () => {
        const result = await dialog.showOpenDialog({
            title: 'Import Wallpapers',
            properties: ['openFile', 'multiSelections'],
            filters: [{
                name: 'Wallpaper files',
                extensions: [
                    'jpg', 'jpeg', 'png', 'bmp',
                    'mp4', 'webm', 'mov', 'm4v'
                ]
            }]
        });

        if (result.canceled || !result.filePaths.length) return [];

        fs.mkdirSync(libraryDir(), { recursive: true });

        const items = readLibrary();
        const added = [];

        const allowed = [
            '.jpg', '.jpeg', '.png', '.bmp',
            '.mp4', '.webm', '.mov', '.m4v'
        ];

        for (const sourcePath of result.filePaths) {
            const ext = path.extname(sourcePath).toLowerCase();
            if (!allowed.includes(ext)) continue;

            const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
            const destination = path.join(libraryDir(), `${id}${ext}`);

            fs.copyFileSync(sourcePath, destination);

            const item = {
                id,
                name: path.basename(sourcePath, ext),
                filePath: destination,
                kind: ['.mp4', '.webm', '.mov', '.m4v'].includes(ext) ? 'video' : 'image',
                startTime: 0,
                endTime: 0
            };

            items.push(item);
            added.push({ ...item, url: pathToFileURL(destination).href });
        }

        writeLibrary(items);
        return added;
    });

    ipcMain.handle('library:update', async (_event, update) => {
        if (!update || typeof update.id !== 'string') {
            throw new Error('Invalid wallpaper.');
        }

        const items = readLibrary();
        const item = items.find(entry => entry.id === update.id);

        if (!item) throw new Error('Wallpaper not found.');

        if (typeof update.name === 'string' && update.name.trim()) {
            item.name = update.name.trim().slice(0, 120);
        }

        if (Number.isFinite(update.startTime) && update.startTime >= 0) {
            item.startTime = update.startTime;
        }

        if (Number.isFinite(update.endTime) && update.endTime >= 0) {
            item.endTime = update.endTime;
        }

        writeLibrary(items);
        return item;
    });

    ipcMain.handle('library:delete', async (_event, id) => {
        const items = readLibrary();
        const item = items.find(entry => entry.id === id);

        if (!item) return false;

        if (videoWindow && videoWindow.filePath === item.filePath) {
            closeVideoWallpaper();
        }

        try {
            fs.unlinkSync(item.filePath);
        } catch {}

        writeLibrary(items.filter(entry => entry.id !== id));

        const playlists = readPlaylists().map(playlist => ({
            ...playlist,
            items: (playlist.items || []).filter(entry => entry.id !== id)
        }));

        writePlaylists(playlists);
        return true;
    });

    // WALLPAPER IPC

    ipcMain.handle('set-wallpaper', async (_event, filePath) => setImageWallpaper(filePath));
    ipcMain.handle('set-video-wallpaper', async (_event, options) => setVideoWallpaper(options));
    ipcMain.handle('remove-wallpaper', async () => removeWallpaper());

    // PLAYLIST IPC

    ipcMain.handle('playlists:list', async () => readPlaylists());

    ipcMain.handle('playlists:save', async (_event, playlist) => {
        if (!playlist || typeof playlist.name !== 'string' || !playlist.name.trim()) {
            throw new Error('Enter a playlist name.');
        }

        const all = readPlaylists();

        const clean = {
            id: playlist.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: playlist.name.trim().slice(0, 80),
            mode: playlist.mode === 'shuffle' ? 'shuffle' : 'order',
            view: playlist.view === 'list' ? 'list' : 'grid',
            fade: Math.max(0, Math.min(10, Number(playlist.fade) || 1)),
            items: Array.isArray(playlist.items)
                ? playlist.items
                    .filter(item => item && typeof item.filePath === 'string' && fs.existsSync(item.filePath))
                    .map(item => ({
                        id: item.id,
                        name: String(item.name || 'Wallpaper'),
                        filePath: item.filePath,
                        kind: item.kind === 'video' ? 'video' : 'image',
                        duration: Math.max(1, Math.min(3600, Number(item.duration) || 30)),
                        speed: Math.max(0.25, Math.min(4, Number(item.speed) || 1)),
                        playUntilEnd: item.kind === 'video' && item.playUntilEnd === true
                    }))
                : []
        };

        if (!clean.items.length) {
            throw new Error('Add at least one wallpaper to the playlist.');
        }

        const index = all.findIndex(entry => entry.id === clean.id);

        if (index >= 0) all[index] = clean;
        else all.push(clean);

        writePlaylists(all);
        return clean;
    });

    ipcMain.handle('playlists:delete', async (_event, id) => {
        writePlaylists(readPlaylists().filter(playlist => playlist.id !== id));
        return true;
    });

    ipcMain.handle('playlists:play', async (_event, playlist) => playPlaylist(playlist));

    // SETTINGS IPC

    ipcMain.handle('settings:get', async () => readSettings());

    ipcMain.handle('settings:save', async (_event, updates) => {
        if (!updates || typeof updates !== 'object') {
            throw new Error('Invalid settings.');
        }

        const current = readSettings();
        const next = { ...current };

        const booleanSettings = [
            'autoOpen',
            'autoPlay',
            'startMinimized',
            'minimizeToTray',
            'rememberLastPage'
        ];

        for (const key of booleanSettings) {
            if (typeof updates[key] === 'boolean') {
                next[key] = updates[key];
            }
        }

        if (updates.defaultView === 'grid' || updates.defaultView === 'list') {
            next.defaultView = updates.defaultView;
        }

        if (Number.isFinite(Number(updates.defaultFade))) {
            next.defaultFade = Math.max(0, Math.min(10, Number(updates.defaultFade)));
        }

        if (Number.isFinite(Number(updates.defaultPhotoDuration))) {
            next.defaultPhotoDuration = Math.max(1, Math.min(3600, Number(updates.defaultPhotoDuration)));
        }

        const allowedPages = ['home', 'library', 'playlists', 'settings', 'widgets'];

        if (allowedPages.includes(updates.lastPage)) {
            next.lastPage = updates.lastPage;
        }

        writeSettings(next);
        applyStartupSetting(next.autoOpen);

        if (next.minimizeToTray) createTray();

        return next;
    });

    ipcMain.handle('settings:reset', async () => {
        writeSettings({ ...defaultSettings });
        applyStartupSetting(false);
        return readSettings();
    });

    function setupAutoUpdates() {
        // Development builds should never check for published updates.
        if (!app.isPackaged || process.platform !== 'win32') return;

        let updatePromptShown = false;

        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = false;

        autoUpdater.on('checking-for-update', () => {
            diagnosticLog('Checking for application updates');
        });

        autoUpdater.on('update-available', info => {
            diagnosticLog('Application update available', {
                version: info.version
            });
        });

        autoUpdater.on('update-not-available', info => {
            diagnosticLog('Application is up to date', {
                version: info.version
            });
        });

        autoUpdater.on('download-progress', progress => {
            diagnosticLog('Application update download progress', {
                percent: Math.round(progress.percent)
            });
        });

        autoUpdater.on('update-downloaded', async info => {
            if (updatePromptShown) return;
            updatePromptShown = true;

            diagnosticLog('Application update downloaded', {
                version: info.version
            });

            const result = await dialog.showMessageBox({
                type: 'info',
                title: 'Sampsons Wallpaper Engine Update',
                message: `Version ${info.version} is ready to install!`,
                detail: 'Restart Sampsons Wallpaper Engine to install the update.',
                buttons: ['Restart and Install', 'Later'],
                defaultId: 0,
                cancelId: 1,
                noLink: true
            });

            if (result.response === 0) {
                diagnosticLog('User accepted application update installation');

                isQuitting = true;
                closeVideoWallpaper();

                autoUpdater.quitAndInstall();
            }
        });

        autoUpdater.on('error', error => {
            diagnosticLog('Application updater error', {
                message: error.message,
                stack: error.stack
            });
        });

        autoUpdater.checkForUpdates().catch(error => {
            diagnosticLog('Could not check for application updates', {
                message: error.message,
                stack: error.stack
            });
        });
    }

    // APP STARTUP

    app.whenReady().then(async () => {
        diagnosticLog('Sampsons Wallpaper Engine main process started', {
            appVersion: app.getVersion(),
            isPackaged: app.isPackaged,
            platform: process.platform,
            architecture: process.arch,
            executable: process.execPath,
            appDirectory: __dirname,
            resourcesPath: process.resourcesPath,
            userData: app.getPath('userData'),
            diagnosticLog: videoDiagnosticFile()
        });

        setupAutoUpdates();
        const settings = readSettings();

        applyStartupSetting(settings.autoOpen);

        if (settings.minimizeToTray) createTray();

        createWindow();

        if (settings.autoPlay) {
            restoreWallpaperAtStartup().catch(error => {
                diagnosticLog('Unexpected startup wallpaper restoration error', {
                    message: error.message,
                    stack: error.stack
                });
                console.error('Could not restore the last wallpaper:', error);
            });
        }

        app.on('activate', showMainWindow);
    });

    app.on('second-instance', showMainWindow);

    app.on('before-quit', () => {
        isQuitting = true;
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin' && !videoWindow && !readSettings().minimizeToTray) {
            app.quit();
        }
    });
}


