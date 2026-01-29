import { isDev } from "./util.js"
import path from "path"
import { app } from "electron"

export function getPreloadPath() {
    const base = path.resolve(app.getAppPath(), isDev() ? "." : "..");
    return path.join(base, "dist-electron", "electron", "preload.cjs");
}

export function getUIPath() {
    return path.join(app.getAppPath(), '/dist-react/index.html');
}

export function getIconPath() {
    const base = path.resolve(app.getAppPath(), isDev() ? "." : "..");
    return path.join(base, "templateIcon.png");
}
