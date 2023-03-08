import { ChildProcess, execFile } from "child_process";
import { access, constants, mkdtemp, rm, writeFile } from "fs/promises";
import net from "net";
import { delimiter, join, resolve } from "path";
import process from "process";

import WebSocket from "ws";

async function getTempDir() {
    const paths = [
        process.env.TMPDIR,
        process.env.TEMP,
        process.env.TMP,
        "/tmp",
        "/var/tmp",
        "/usr/tmp",
    ];
    for (const p of paths) {
        if (!p) continue;
        try {
            await access(p, constants.R_OK | constants.W_OK);
        } catch {
            continue;
        }
        return p;
    }
    return process.cwd();
}

async function findAvailablePort(): Promise<number> {
    const server = new net.Server();
    server.listen(0, "");
    return new Promise((resolve, reject) => {
        let port: number;
        server.once("error", reject);
        server.once("listening", () => {
            port = (server.address() as net.AddressInfo).port;
            server.close();
        });
        server.once("close", () => {
            resolve(port);
        });
    });
}

async function which(bin: string) {
    for (const path of process.env.PATH!.split(delimiter)) {
        const binPath = join(path, bin);
        try {
            await access(binPath, constants.X_OK);
        } catch {
            continue;
        }
        return binPath;
    }
    return null;
}

const firefoxPreferences: Record<string, any> = {
    "devtools.chrome.enabled": true,
    "devtools.debugger.remote-enabled": true,
    "devtools.debugger.prompt-connection": false,
    "extensions.update.enabled": false,
    "xpinstall.signatures.required": false,

    // disable some first-startup things
    "browser.reader.detectedFirstArticle": true,
    "browser.startup.homepage": "about:blank",
    "browser.tabs.firefox-view": false,
    "startup.homepage_welcome_url": "about:blank",
    "datareporting.policy.dataSubmissionEnabled": false,
};

const firefoxBinaries = [
    "firefox-developer-edition",
    "firefox-nightly",
    "firefox-beta",
    "firefox-esr",
    "firefox",
];

enum LogLevel {
    debug,
    info,
    log,
    warn,
    error,
    quiet,
}

type LogLevelStr = keyof typeof LogLevel;

function ffeineLog(this: Logger, level: Exclude<LogLevelStr, "quiet">, ...args: any[]) {
    if (this.logLevel > LogLevel[level])
        return;
    if (typeof args[0] === "string")
        console[level](`[ffeine:${this.scope}] ${args[0]}`, ...args.slice(1));
    else
        console[level](`[ffeine:${this.scope}]`, ...args);
}

/**
 * Thin wrapper around `console` that adds a scope prefix and can be configured
 * to ignore log levels.
 */
class Logger {
    constructor(public scope: string, public logLevel: LogLevel) {}

    for(subscope: string) {
        return new Logger(`${this.scope}.${subscope}`, this.logLevel);
    }

    debug = ffeineLog.bind(this, "debug");
    info = ffeineLog.bind(this, "info");
    log = ffeineLog.bind(this, "log");
    warn = ffeineLog.bind(this, "warn");
    error = ffeineLog.bind(this, "error");
}

interface Extension {
    actor: string;
    debuggable: boolean;
    hidden: boolean;
    iconURL?: string;
    id: string;
    isSystem: boolean;
    isWebExtension: boolean;
    manifestURL: string;
    name: string;
    persistentBackgroundScript: boolean;
    temporarilyInstalled: boolean;
    traits: unknown;
    url?: string;
    warnings: unknown[];
}

interface BrowserOptions {
    url?: string;
    logLevel?: LogLevelStr;
    logName?: string;
    binaryPath?: string;
}

export abstract class Browser {
    process?: ChildProcess;
    cdp?: CDP;
    protected logger: Logger;
    protected cachedActors?: any;

    constructor(public options: BrowserOptions = {}) {
        const logName = options.logName ?? this.constructor.name.toLowerCase();
        this.logger = new Logger(logName, LogLevel[options.logLevel ?? "warn"]);
    }

    /** Launch the browser and setup debugger connection. */
    abstract launch(): Promise<void>;

    protected async waitForCDP(): Promise<CDP> {
        if (!this.cdp) {
            await this.launch();
            if (!this.cdp)
                throw new Error("failed to start launch browser");
        }
        return this.cdp;
    }

    async getActors() {
        return this.cachedActors ??= await (await this.waitForCDP()).request("getRoot");
    }

    async installExtension(path: string) {
        path = resolve(path);
        const cdp = await this.waitForCDP();
        const { addonsActor } = await this.getActors();
        const reply = await cdp.request("installTemporaryAddon", addonsActor, { addonPath: path });
        const addonId = reply.addon.id as string;
        return (await this.listExtensions()).find(({ id }) => id === addonId) as Extension;
    }

    async listExtensions() {
        const cdp = await this.waitForCDP();
        return (await cdp.request("listAddons")).addons as any[];
    }

    async reloadExtension(ext: Extension) {
        const cdp = await this.waitForCDP();
        await cdp.request("reload", ext.actor);
    }
}

export class Firefox extends Browser {
    protected async setupProfile(): Promise<string> {
        const profilePath = await mkdtemp(join(await getTempDir(), "ffeine."));
        this.logger.debug(`Creating temporary profile at ${profilePath}}`);
        await writeFile(
            // why is it a js file what
            join(profilePath, "prefs.js"),
            Object.entries(firefoxPreferences)
                .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
                .join("\n"),
        );

        return profilePath;
    }

    protected async getDefaultBinary() {
        return (await Promise.all(firefoxBinaries.map(which))).find(v => v) ?? null;
    }

    async launch() {
        const firefoxLogger = this.logger.for("instance");

        const binaryPath = this.options.binaryPath ?? await this.getDefaultBinary();
        if (!binaryPath)
            throw new Error("couldn't find a suitable firefox executable");

        const port = await findAvailablePort();
        const profilePath = await this.setupProfile();
        const args = [
            "--no-remote", // (don't send remote commands to other firefox instances)
            "--start-debugger-server",
            `ws:${port}`,
            "--profile",
            profilePath,
        ];

        if (this.options.url)
            args.push(this.options.url);

        this.logger.info("Launching Firefox:", binaryPath, ...args);
        const firefox = execFile(binaryPath, args);
        firefox.stdout?.on("data", data => firefoxLogger.debug("(stdout)", data));
        firefox.stderr?.on("data", data => firefoxLogger.debug("(stderr)", data));
        firefox.on("exit", () => rm(profilePath, { recursive: true }));
        process.on("exit", () => firefox.kill());
        this.process = firefox;
        this.cdp = new CDP(`ws://localhost:${port}`, {
            logName: `cdp@:${port}`,
            logLevel: this.options.logLevel,
        });
        await this.cdp.connect();
    }
}

interface CDPOptions {
    logLevel?: LogLevelStr;
    logName?: string;
}

/** Class implementing the Chrome Debugging Protocol, which is (partially) supported by Firefox */
export class CDP {
    connected: boolean;
    protected logger: Logger;
    protected ws?: WebSocket;
    protected pendingReplies: Record<string, [(r: any) => void, (e: any) => void][]>;

    constructor(public address: string, public options: CDPOptions = {}) {
        this.logger = new Logger(options.logName ?? "cdp", LogLevel[options.logLevel ?? "error"]);
        this.connected = false;
        this.pendingReplies = {};
    }

    async connect() {
        for (let i = 1; i <= 5; i++) {
            try {
                this.ws = await new Promise((resolve, reject) => {
                    this.logger.info(i > 1 ? `Connecting CDP (attempt ${i})` : "Connecting CDP");
                    const ws = new WebSocket(this.address);
                    ws.once("error", e => setTimeout(() => reject(e), 1500));
                    ws.once("message", data => {
                        this.logger.debug(data.toString("utf8"));
                        ws.on("message", data => this.onMessage(data as Buffer));
                        resolve(ws);
                    });
                });
            } catch (e) {
                continue;
            }
            this.connected = true;
            this.logger.info("Connected!");
            return;
        }
        throw new Error("failed to connect CDP");
    }

    async request(type: string, to = "root", props: any = {}): Promise<any> {
        if (!this.connected || !this.ws)
            await this.connect();
        this.ws!.send(JSON.stringify({ type, to, ...props }));
        return new Promise((resolve, reject) => (this.pendingReplies[to] ??= []).push([resolve, reject]));
    }

    protected onMessage(data: Buffer) {
        const reply = JSON.parse(data.toString("utf8"));
        this.logger.debug(reply);
        const [resolve, reject] = this.pendingReplies[reply.from].shift() ?? [];
        if (!resolve || !reject) {
            this.logger.warn("Received unexpected reply!", reply);
            return;
        }

        if (reply.error)
            reject(new Error(`${reply.from} => ${reply.error}: ${reply.message}`));
        else
            resolve(reply);
    }
}
