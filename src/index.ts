import { ChildProcess, execFile } from "child_process";
import { access, constants, cp, mkdir, mkdtemp, readdir, rm, writeFile } from "fs/promises";
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
    "browser.aboutConfig.showWarning": false,
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

export interface FirefoxExtension {
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

export interface BrowserOptions {
    /**
     * Initial URL to open the browser window at.
     */
    url?: string;
    /**
     * Suppress log messages below this level. Defaults to "warn".
     */
    logLevel?: LogLevelStr;
    /**
     * The name shown on logs from this instance (e.g. `firefox`).
     */
    logName?: string;
    /**
     * Path to the browser's binary. Default is to autodetect one.
     */
    binaryPath?: string;
    /**
     * Optional list of extension IDs you intend to add. This causes ffeine to
     * automatically grant permissions to them without prompting on Firefox.
     */
    extensionIds?: string[];
    /**
     * A list of scripts that will be automatically executed on each new tab
     * for the given url matches.
     */
    injectScripts?: { matches: (string | RegExp)[]; js: string }[];
}

export abstract class Browser {
    process?: ChildProcess;
    protected logger: Logger;

    constructor(public readonly options: BrowserOptions = {}) {
        const logName = options.logName ?? this.constructor.name.toLowerCase();
        this.logger = new Logger(logName, LogLevel[options.logLevel ?? "warn"]);
    }

    /** Launch the browser and setup debugger connection. */
    abstract launch(): Promise<void>;

    abstract installExtension(path: string): Promise<any>;

    abstract reloadExtension(extension: any): Promise<void>;
}

export class Firefox extends Browser {
    rdp?: RDP;
    protected cachedActors?: any;

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
        await this.setupExtensionPreferences(profilePath);
        return profilePath;
    }

    protected async setupExtensionPreferences(profilePath: string) {
        if (!this.options.extensionIds)
            return;
        // XXX: maybe `permissions` could be configurable?
        const prefs = { permissions: [], origins: ["<all_urls>"] };
        await writeFile(
            join(profilePath, "extension-preferences.json"),
            JSON.stringify(Object.fromEntries(
                this.options.extensionIds.map(id => [id, prefs]),
            )),
        );
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
        const rdp = new RDP(`ws://localhost:${port}`, {
            logName: `firefox.rdp@:${port}`,
            logLevel: this.options.logLevel,
        });
        await rdp.connect();
        const injectedIds = new Set<string>();
        rdp.watch("tabListChanged", "listTabs", async ({ tabs }) => {
            if (!this.options.injectScripts)
                return;
            for (const { actor, browserId, url } of tabs) {
                if (injectedIds.has(browserId))
                    continue;

                for (const { matches, js } of this.options.injectScripts) {
                    if (!matches.some(m => (<string>url).match(m)))
                        continue;

                    const { frame } = await rdp.request("getTarget", actor);
                    await rdp.request("evaluateJSAsync", frame.consoleActor, { text: js });
                }
                injectedIds.add(browserId);
            }
        });
        this.rdp = rdp;
    }

    protected async waitForRDP(): Promise<RDP> {
        if (!this.rdp) {
            await this.launch();
            if (!this.rdp)
                throw new Error("failed to start launch browser");
        }
        return this.rdp;
    }

    async getActors() {
        return this.cachedActors ??= await (await this.waitForRDP()).request("getRoot");
    }

    async installExtension(path: string) {
        path = resolve(path);
        const rdp = await this.waitForRDP();
        const { addonsActor } = await this.getActors();
        const reply = await rdp.request("installTemporaryAddon", addonsActor, { addonPath: path });
        const addonId = reply.addon.id as string;
        return (await this.listExtensions()).find(({ id }) => id === addonId) as FirefoxExtension;
    }

    async listExtensions() {
        const rdp = await this.waitForRDP();
        return (await rdp.request("listAddons")).addons as any[];
    }

    async reloadExtension(ext: FirefoxExtension) {
        const rdp = await this.waitForRDP();
        await rdp.request("reload", ext.actor);
    }
}

export interface RDPOptions {
    logLevel?: LogLevelStr;
    logName?: string;
}

export class RDP {
    connected: boolean;
    protected logger: Logger;
    protected ws?: WebSocket;
    protected pendingReplies: Record<string, [(r: any) => void, (e: any) => void][]>;
    protected listeners: Record<string, [any, (data: any, reply: any) => void][]>;

    constructor(public address: string, public options: RDPOptions = {}) {
        this.logger = new Logger(options.logName ?? "rdp", LogLevel[options.logLevel ?? "error"]);
        this.connected = false;
        this.pendingReplies = {};
        this.listeners = {};
    }

    async connect() {
        for (let i = 1; i <= 5; i++) {
            try {
                this.ws = await new Promise((resolve, reject) => {
                    this.logger.info(i > 1 ? `Connecting RDP (attempt ${i})` : "Connecting RDP");
                    const ws = new WebSocket(this.address);
                    ws.once("open", () => {
                        this.logger.info("Waiting for initial message");
                        setTimeout(() => reject(), 1500);
                    });
                    ws.once("error", e => setTimeout(() => reject(e), 1500));
                    ws.once("message", data => {
                        this.logger.debug(data.toString("utf8"));
                        ws.on("message", data => this.onMessage(data as Buffer));
                        resolve(ws);
                    });
                });
            } catch (e) {
                this.logger.info(e);
                continue;
            }
            this.connected = true;
            this.logger.info("Connected!");
            return;
        }
        throw new Error("failed to connect RDP");
    }

    async request(type: string, to = "root", props: any = {}): Promise<any> {
        if (!this.connected || !this.ws)
            await this.connect();
        this.ws!.send(JSON.stringify({ type, to, ...props }));
        return new Promise((resolve, reject) => (this.pendingReplies[to] ??= []).push([resolve, reject]));
    }

    async watch(
        event: string,
        execute: { type: string; to?: string; props?: any } | string,
        cb: (data: any, reply: any) => void,
    ) {
        if (typeof execute === "string")
            execute = { type: execute };
        await this.request(execute.type, execute.to, execute.props);
        (this.listeners[event] ??= []).push([execute, cb]);
    }

    async unwatch(event: string, callback: (data: any, reply: any) => void) {
        const listeners = this.listeners[event];
        const i = listeners.findIndex(([, cb]) => cb === callback);
        if (i >= 0) listeners.splice(i);
    }

    protected onMessage(data: Buffer) {
        const reply = JSON.parse(data.toString("utf8"));
        this.logger.debug(reply);

        if (reply.type) {
            this.listeners[reply.type]?.forEach(async ([r, cb]) =>
                cb(
                    await this.request(r.type, r.to, r.props),
                    reply,
                )
            );
            return;
        }

        const [resolve, reject] = this.pendingReplies[reply.from]?.shift() ?? [];
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
