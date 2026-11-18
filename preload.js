const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wallpaperAPI', {
    // Wallpaper library
    listWallpapers: () =>
        ipcRenderer.invoke('library:list'),

    importWallpapers: () =>
        ipcRenderer.invoke('library:import'),

    updateWallpaper: update =>
        ipcRenderer.invoke('library:update', update),

    deleteWallpaper: id =>
        ipcRenderer.invoke('library:delete', id),

    // Setting wallpapers
    setWallpaper: filePath =>
        ipcRenderer.invoke('set-wallpaper', filePath),

    setVideoWallpaper: (filePath, startTime = 0, endTime = 0) =>
        ipcRenderer.invoke('set-video-wallpaper', {
            filePath,
            startTime,
            endTime
        }),

    removeWallpaper: () =>
        ipcRenderer.invoke('remove-wallpaper'),

    // Playlists
    listPlaylists: () =>
        ipcRenderer.invoke('playlists:list'),

    savePlaylist: playlist =>
        ipcRenderer.invoke('playlists:save', playlist),

    deletePlaylist: id =>
        ipcRenderer.invoke('playlists:delete', id),

    playPlaylist: playlist =>
        ipcRenderer.invoke('playlists:play', playlist),

    // Settings
    getSettings: () =>
        ipcRenderer.invoke('settings:get'),

    saveSettings: settings =>
        ipcRenderer.invoke('settings:save', settings),

    resetSettings: () =>
        ipcRenderer.invoke('settings:reset')
});